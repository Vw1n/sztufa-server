import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { BACKUP_MODULE_REGISTRY, BackupModule } from './backup-module-registry';
import { getSeasonModuleWhereClause } from './backup-plan.service';
import { TABLE_METADATA_MAP, PersistentBackupTableName } from './backup-table-registry';

export const CURRENT_FINGERPRINT_VERSION = 1;

export function getCanonicalSelectorKey(
  module: BackupModule,
  selector?: { seasonId?: string },
): string {
  if (module === 'season') {
    if (!selector?.seasonId || !selector.seasonId.trim()) {
      throw new BadRequestException('赛季模块备份必须指定 seasonId');
    }
    return `season:${selector.seasonId.trim()}`;
  }
  return module;
}

export function getCanonicalLockKey(
  module: BackupModule,
  selector?: { seasonId?: string },
): string {
  return `lock:backup:${getCanonicalSelectorKey(module, selector)}`;
}

export interface TableFingerprint {
  readonly table: string;
  readonly rowCount: number;
  readonly maxUpdatedAt: string | null;
  readonly minUpdatedAt: string | null;
  readonly maxId: string | null;
  readonly minId: string | null;
  readonly activeCount?: number;
  readonly deletedCount?: number;
  readonly statusCounts?: Record<string, number>;
  readonly projectionHash?: string;
}

export interface ModuleFingerprintResult {
  readonly module: BackupModule;
  readonly selectorKey: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly tableFingerprints: TableFingerprint[];
  readonly durationMs: number;
}

function canonicalStringify(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
}

@Injectable()
export class BackupFingerprintService {
  private readonly logger = new Logger(BackupFingerprintService.name);

  constructor(private readonly prisma: PrismaService) {}

  async calculateModuleFingerprint(
    module: BackupModule,
    selector?: { seasonId?: string },
  ): Promise<ModuleFingerprintResult> {
    const startedAt = Date.now();
    const selectorKey = getCanonicalSelectorKey(module, selector);
    const seasonId = module === 'season' ? selector?.seasonId?.trim() : undefined;

    const definition = BACKUP_MODULE_REGISTRY[module];
    const targetTables: PersistentBackupTableName[] = [
      ...definition.ownedTables,
      ...definition.referenceTables,
    ];

    const tableFingerprints: TableFingerprint[] = await Promise.all(
      targetTables.map(async (table) => this.computeTableFingerprint(table, seasonId)),
    );

    tableFingerprints.sort((a, b) => a.table.localeCompare(b.table));

    const canonicalData = {
      version: CURRENT_FINGERPRINT_VERSION,
      module,
      selectorKey,
      tables: tableFingerprints,
    };

    const canonicalJson = canonicalStringify(canonicalData);
    const fingerprint = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
    const durationMs = Date.now() - startedAt;

    if (durationMs > 500) {
      this.logger.warn(
        `[FingerprintSlowQuery] ${module}:${selectorKey} 指纹计算耗时 ${durationMs}ms，超出 100ms 目标预算`,
      );
    }

    return {
      module,
      selectorKey,
      version: CURRENT_FINGERPRINT_VERSION,
      fingerprint,
      tableFingerprints,
      durationMs,
    };
  }

  private async computeTableFingerprint(
    tableName: PersistentBackupTableName,
    seasonId?: string,
  ): Promise<TableFingerprint> {
    const meta = TABLE_METADATA_MAP[tableName];
    const delegate = (this.prisma as any)[meta.prismaDelegateName];
    if (!delegate) {
      throw new Error(`Prisma delegate not found for table: ${tableName}`);
    }

    const where = seasonId ? getSeasonModuleWhereClause(tableName, seasonId) : {};
    const hasDeletedAt = meta.dateFields.includes('deletedAt');
    const hasUpdatedAt = meta.dateFields.includes('updatedAt');
    const hasCreatedAt = meta.dateFields.includes('createdAt');

    const maxFields: Record<string, true> = { id: true };
    const minFields: Record<string, true> = { id: true };

    if (hasUpdatedAt) {
      maxFields.updatedAt = true;
      minFields.updatedAt = true;
    } else if (hasCreatedAt) {
      maxFields.createdAt = true;
      minFields.createdAt = true;
    }

    // 1. 聚合查询 rowCount, max/min 时间戳与 ID
    const aggPromise = delegate.aggregate({
      where,
      _count: { _all: true },
      _max: maxFields,
      _min: minFields,
    });

    // 2. 软删除表额外查 deletedCount
    const deletedCountPromise = hasDeletedAt
      ? delegate.count({ where: { ...where, deletedAt: { not: null } } })
      : Promise.resolve(undefined);

    // 3. MatchLineup 轻量投影哈希
    const lineupHashPromise =
      tableName === 'MatchLineup'
        ? delegate
            .findMany({
              where,
              select: {
                id: true,
                matchId: true,
                playerId: true,
                teamType: true,
                lineupType: true,
              },
              orderBy: { id: 'asc' },
            })
            .then((rows: any[]) =>
              crypto.createHash('sha256').update(canonicalStringify(rows)).digest('hex'),
            )
        : Promise.resolve(undefined);

    // 4. HistoryImportBatch 额外捕获 undoneAt 与状态分布
    const historyExtraPromise =
      tableName === 'HistoryImportBatch'
        ? delegate
            .aggregate({
              where,
              _max: { undoneAt: true },
            })
            .then((res: any) => ({
              maxUndoneAt: res._max?.undoneAt ? new Date(res._max.undoneAt).toISOString() : null,
            }))
        : Promise.resolve(undefined);

    const [aggRes, deletedCount, projectionHash, historyExtra] = await Promise.all([
      aggPromise,
      deletedCountPromise,
      lineupHashPromise,
      historyExtraPromise,
    ]);

    const rowCount: number = aggRes._count?._all || 0;
    const maxTsRaw = hasUpdatedAt ? aggRes._max?.updatedAt : aggRes._max?.createdAt;
    const minTsRaw = hasUpdatedAt ? aggRes._min?.updatedAt : aggRes._min?.createdAt;

    const maxUpdatedAt = maxTsRaw ? new Date(maxTsRaw).toISOString() : null;
    const minUpdatedAt = minTsRaw ? new Date(minTsRaw).toISOString() : null;
    const maxId = aggRes._max?.id || null;
    const minId = aggRes._min?.id || null;

    const result: any = {
      table: tableName,
      rowCount,
      maxUpdatedAt,
      minUpdatedAt,
      maxId,
      minId,
    };

    if (hasDeletedAt && typeof deletedCount === 'number') {
      result.deletedCount = deletedCount;
      result.activeCount = Math.max(0, rowCount - deletedCount);
    }

    if (projectionHash) {
      result.projectionHash = projectionHash;
    }

    if (historyExtra?.maxUndoneAt) {
      result.maxUndoneAt = historyExtra.maxUndoneAt;
    }

    return result as TableFingerprint;
  }
}
