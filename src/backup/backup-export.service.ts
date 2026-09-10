import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  MandatoryBackupTableName,
  PersistentBackupTableName,
  TABLE_METADATA_MAP,
} from './backup-table-registry';
import { createV3BackupStream, createV4BackupStream } from './backup-serializer';
import { BackupScopeService, getSeasonTableWhereClause } from './backup-scope.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupMetadata, CreateBackupOptions } from './backup.types';
import { BackupPlan, BackupPlanService } from './backup-plan.service';
import { buildBackupFilename } from './backup-filename';

export class BackupExportException extends Error {
  constructor(
    message: string,
    public readonly partialMetrics: {
      databaseBytesEstimated: number;
      uncompressedBytes: number;
      databaseRowsRead: number;
      peakRssBytes?: number;
    },
    public readonly cause?: any,
  ) {
    super(message);
    this.name = 'BackupExportException';
  }
}

/**
 * 备份导出服务。
 * 负责：解析备份范围、游标分页读取数据、构建 V3 流式备份、上传至 R2、
 * 响应客户端取消信号、上传失败后的补偿清理与导出审计日志。
 */
@Injectable()
export class BackupExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly objectStore: BackupObjectStoreService,
    private readonly verificationService: BackupVerificationService,
    private readonly auditLogService: AuditLogService,
    private readonly scopeService: BackupScopeService,
    private readonly planService: BackupPlanService,
  ) {}

  async createBackup(username: string, options?: CreateBackupOptions): Promise<BackupMetadata> {
    const startedAt = Date.now();
    const purpose = options?.purpose || 'manual';
    const isProtected = !!options?.protected;
    const scope = options?.scope || 'full';

    // 归档保护与恢复前保护安全约束统一校验
    if (purpose === 'archive' || isProtected) {
      if (purpose === 'archive') {
        if (!isProtected) {
          throw new BadRequestException(
            '归档保护备份必须同时满足 purpose="archive" 且 protected=true，二者必须严格配套',
          );
        }
        if (scope !== 'module' || options?.module !== 'season') {
          throw new BadRequestException(
            '归档保护备份仅允许在 scope="module" 且 module="season" 时创建',
          );
        }
        const targetSeasonId = options?.selector?.seasonId;
        if (!targetSeasonId) {
          throw new BadRequestException('归档保护备份必须指定目标 seasonId (selector.seasonId)');
        }
        const season = await this.prisma.season.findUnique({ where: { id: targetSeasonId } });
        if (!season) {
          throw new BadRequestException('目标赛季不存在');
        }
        if (season.status !== 'archived') {
          throw new BadRequestException(
            `仅状态为已归档 (archived) 的赛季允许创建归档保护备份，当前赛季状态为 "${season.status}"`,
          );
        }
      } else if (purpose === 'pre-restore') {
        // pre-restore 快照允许受保护 (protected=true)，防止保留策略误清理关键回滚点
      } else {
        // manual, scheduled, uploaded 等普通备份不允许标记为 protected: true
        throw new BadRequestException(
          `仅 purpose="archive" 或 purpose="pre-restore" 允许设置受保护标记 (protected=true)，当前 purpose="${purpose}"`,
        );
      }
    }

    const pageSize = parseInt(process.env.BACKUP_PAGE_SIZE || '500', 10);
    const isModuleBackup = scope === 'module';
    let plan: BackupPlan | undefined;

    if (isModuleBackup) {
      plan = await this.planService.compile({
        scope: 'module',
        module: options?.module,
        selector: options?.selector,
      });
    }

    let seasonInfo: { id: string; name: string } | undefined = undefined;

    if (scope === 'season') {
      if (!options?.seasonId) {
        throw new BadRequestException('分赛季导出必须提供关联的 seasonId');
      }
      const seasonObj = await this.scopeService.validateSeason(options.seasonId);
      seasonInfo = { id: seasonObj.id, name: seasonObj.name };
    }

    const pageIteratorProvider = (tableName: PersistentBackupTableName) => {
      const meta = TABLE_METADATA_MAP[tableName];
      const prismaDelegate = (this.prisma as any)[meta.prismaDelegateName];
      const plannedTable = plan?.tables.find((table) => table.tableName === tableName);

      const whereClause =
        plannedTable?.where ||
        (scope === 'season' && options?.seasonId
          ? getSeasonTableWhereClause(tableName as MandatoryBackupTableName, options.seasonId)
          : {});

      const isSeasonPlayerExport =
        (scope === 'season' || (scope === 'module' && options?.module === 'season')) &&
        tableName === 'Player';
      const targetSeasonId = options?.seasonId || options?.selector?.seasonId;

      return (async function* () {
        let lastId: string | null = null;
        let hasMore = true;

        while (hasMore) {
          if (options?.signal?.aborted) {
            throw new BadRequestException('客户端连接已断开，备份导出取消');
          }

          const findOptions: any = {
            where: whereClause,
            orderBy: { [meta.cursorField]: 'asc' },
            take: pageSize,
          };

          if (isSeasonPlayerExport) {
            findOptions.include = {
              suspendedAtMatch: { select: { seasonId: true } },
            };
          }

          if (lastId) {
            findOptions.cursor = { [meta.cursorField]: lastId };
            findOptions.skip = 1;
          }

          const page: any[] = await prismaDelegate.findMany(findOptions);
          peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

          if (!page || page.length === 0) {
            hasMore = false;
            break;
          }

          const processedPage = page.map((row: any) => {
            if (isSeasonPlayerExport) {
              const { suspendedAtMatch, ...exportRecord } = row;
              if (
                exportRecord.suspendedAtMatchId &&
                suspendedAtMatch?.seasonId !== targetSeasonId
              ) {
                exportRecord.suspendedAtMatchId = null;
              }
              return exportRecord;
            }
            return row;
          });

          yield processedPage;

          lastId = page[page.length - 1][meta.cursorField];
          if (page.length < pageSize) {
            hasMore = false;
          }
        }
      })();
    };

    let peakRssBytes = process.memoryUsage().rss;
    const createdAt = new Date();
    const createdAtIso = createdAt.toISOString();
    const writerResult = plan
      ? createV4BackupStream(plan, pageIteratorProvider, { createdAt: createdAtIso })
      : createV3BackupStream(pageIteratorProvider, {
          createdAt: createdAtIso,
          scope: scope as 'full' | 'season',
          season: seasonInfo,
        });
    const { stream, checksumPromise, manifestPromise, metricsPromise, getMetricsSnapshot } =
      writerResult;

    const filename = buildBackupFilename({
      module: plan?.module || (scope === 'season' ? 'season' : 'full'),
      season: plan?.season || seasonInfo,
      createdAt,
      purpose,
      protected: isProtected,
    });

    let fileKey = `private-backups/database/full/${filename}`;
    if (scope === 'season' && options?.seasonId) {
      fileKey = `private-backups/database/seasons/${options.seasonId}/${filename}`;
    } else if (plan) {
      const selectorPart = plan.selector.seasonId ? `/${plan.selector.seasonId}` : '';
      fileKey = `private-backups/database/modules/${plan.module}${selectorPart}/${filename}`;
    } else if (purpose === 'pre-restore') {
      fileKey = `private-backups/database/${filename}`;
    }

    const upload = this.objectStore.createUpload(fileKey, filename, stream, options?.signal);

    let checksum = '';
    try {
      await upload.done();
      checksum = await checksumPromise;
      const verified = await this.verificationService.verifyBackupIntegrity(fileKey);
      if (!verified) {
        throw new Error(`备份上传后完整性校验失败: ${fileKey}`);
      }
    } catch (err: any) {
      await upload.abort().catch(() => {});
      try {
        await this.objectStore.deleteObject(fileKey);
      } catch (deleteErr: any) {
        console.error(`[CRITICAL] 备份校验失败且物理删除失败，遗留废弃文件: ${fileKey}`, deleteErr);
      }
      console.error('上传或校验备份文件至 R2 失败:', err);

      const snapshot = getMetricsSnapshot();
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      const wrappedErr = new BackupExportException(
        `无法将备份文件保存至对象存储: ${err.message || '备份导出或保存失败'}`,
        {
          databaseBytesEstimated: snapshot.databaseBytesEstimated,
          uncompressedBytes: snapshot.uncompressedBytes,
          databaseRowsRead: snapshot.databaseRowsRead,
          peakRssBytes,
        },
        err,
      );

      throw wrappedErr;
    }

    let size = 0;
    try {
      const actualSize = await this.objectStore.headObject(fileKey);
      if (typeof actualSize === 'number' && actualSize > 0) {
        size = actualSize;
      }
    } catch {
      // 降级保持 0
    }

    const streamMetrics = await metricsPromise;
    const manifest = await manifestPromise;
    const tablesProcessed = manifest?.tables ? Object.keys(manifest.tables).length : 0;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

    const durationMs = Date.now() - startedAt;
    const metric = {
      scope,
      module: plan?.module || (scope === 'season' ? 'season' : 'full'),
      seasonId: plan?.selector?.seasonId || options?.seasonId,
      purpose,
      uploadedBytes: size,
      databaseBytesEstimated: streamMetrics.databaseBytesEstimated,
      uncompressedBytes: streamMetrics.uncompressedBytes,
      durationMs,
    };
    console.info(`[BackupMetrics] ${JSON.stringify(metric)}`);

    await this.auditLogService.log(
      username,
      'CREATE_BACKUP',
      `触发${plan ? `${plan.module} 模块` : scope === 'season' ? '分赛季' : '全站'}数据库备份 (${plan ? 'V4.0' : 'V3.0'} GZIP)，备份文件: ${fileKey}，上传 ${size} 字节，耗时 ${durationMs}ms。`,
    );

    return {
      key: fileKey,
      filename,
      size,
      lastModified: new Date(),
      formatVersion: plan ? '4.0' : '3.0',
      compressed: true,
      checksum,
      purpose,
      protected: isProtected,
      validated: true,
      scope,
      seasonId: options?.seasonId,
      module: plan?.module === 'full' ? undefined : plan?.module,
      selector: plan?.selector ? { ...plan.selector } : undefined,
      databaseBytesEstimated: streamMetrics.databaseBytesEstimated,
      uncompressedBytes: streamMetrics.uncompressedBytes,
      uploadedBytes: size,
      databaseRowsRead: streamMetrics.databaseRowsRead,
      tablesProcessed,
      peakRssBytes,
    };
  }
}
