import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MandatoryBackupTableName, TABLE_METADATA_MAP } from './backup-table-registry';
import { createV3BackupStream } from './backup-serializer';
import { BackupScopeService, getSeasonTableWhereClause } from './backup-scope.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupMetadata, CreateBackupOptions } from './backup.types';

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
  ) {}

  async createBackup(username: string, options?: CreateBackupOptions): Promise<BackupMetadata> {
    const purpose = options?.purpose || 'manual';
    const isProtected = !!options?.protected;
    const scope = options?.scope || 'full';
    const pageSize = parseInt(process.env.BACKUP_PAGE_SIZE || '500', 10);

    let seasonInfo: { id: string; name: string } | undefined = undefined;

    if (scope === 'season') {
      if (!options?.seasonId) {
        throw new BadRequestException('分赛季导出必须提供关联的 seasonId');
      }
      const seasonObj = await this.scopeService.validateSeason(options.seasonId);
      seasonInfo = { id: seasonObj.id, name: seasonObj.name };
    }

    const pageIteratorProvider = (tableName: MandatoryBackupTableName) => {
      const meta = TABLE_METADATA_MAP[tableName];
      const prismaDelegate = (this.prisma as any)[meta.prismaDelegateName];

      const whereClause =
        scope === 'season' && options?.seasonId
          ? getSeasonTableWhereClause(tableName, options.seasonId)
          : {};

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

          if (scope === 'season' && tableName === 'Player') {
            findOptions.include = {
              suspendedAtMatch: { select: { seasonId: true } },
            };
          }

          if (lastId) {
            findOptions.cursor = { [meta.cursorField]: lastId };
            findOptions.skip = 1;
          }

          const page: any[] = await prismaDelegate.findMany(findOptions);

          if (!page || page.length === 0) {
            hasMore = false;
            break;
          }

          const processedPage = page.map((row: any) => {
            if (scope === 'season' && tableName === 'Player') {
              const { suspendedAtMatch, ...exportRecord } = row;
              if (
                exportRecord.suspendedAtMatchId &&
                suspendedAtMatch?.seasonId !== options?.seasonId
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

    const createdAtIso = new Date().toISOString();
    const { stream, checksumPromise } = createV3BackupStream(pageIteratorProvider, {
      createdAt: createdAtIso,
      scope,
      season: seasonInfo,
    });

    const protectSuffix = isProtected ? '_protected' : '';
    const filename = `backup_${Date.now()}_${purpose}${protectSuffix}.json.gz`;

    let fileKey = `private-backups/database/full/${filename}`;
    if (scope === 'season' && options?.seasonId) {
      fileKey = `private-backups/database/seasons/${options.seasonId}/${filename}`;
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
      if (err instanceof BadRequestException) throw err;
      throw new ServiceUnavailableException('无法将备份文件保存至对象存储');
    }

    await this.auditLogService.log(
      username,
      'CREATE_BACKUP',
      `触发${scope === 'season' ? '分赛季' : '全站'}数据库备份 (V3.0 GZIP)，备份文件: ${fileKey}。`,
    );

    return {
      key: fileKey,
      filename,
      size: 0,
      lastModified: new Date(),
      formatVersion: '3.0',
      compressed: true,
      checksum,
      purpose,
      protected: isProtected,
      validated: true,
      scope,
      seasonId: options?.seasonId,
    };
  }
}
