import { Readable, pipeline } from 'stream';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { MANDATORY_BACKUP_TABLES, MandatoryBackupTableName } from './backup-table-registry';
import { BackupManifestV3, PrepareV3StreamOptions } from './backup-format';
import { BackupManifestV4 } from './backup-format';
import { BackupPlan } from './backup-plan.service';
import { PersistentBackupTableName } from './backup-table-registry';

/**
 * 有界内存流式备份生成器
 */
export function createV3BackupStream(
  pageIteratorProvider: (tableName: MandatoryBackupTableName) => AsyncIterable<any[]>,
  options?: PrepareV3StreamOptions,
): {
  stream: Readable;
  checksumPromise: Promise<string>;
  tableCountsPromise: Promise<Record<string, number>>;
  manifestPromise: Promise<BackupManifestV3>;
} {
  const tableCounts: Record<string, number> = {};
  const tablesHasher = crypto.createHash('sha256');

  let resolveChecksum: (val: string) => void;
  let rejectChecksum: (err: any) => void;
  const checksumPromise = new Promise<string>((res, rej) => {
    resolveChecksum = res;
    rejectChecksum = rej;
  });

  let resolveCounts: (val: Record<string, number>) => void;
  let rejectCounts: (err: any) => void;
  const tableCountsPromise = new Promise<Record<string, number>>((res, rej) => {
    resolveCounts = res;
    rejectCounts = rej;
  });

  let resolveManifest: (val: BackupManifestV3) => void;
  let rejectManifest: (err: any) => void;
  const manifestPromise = new Promise<BackupManifestV3>((res, rej) => {
    resolveManifest = res;
    rejectManifest = rej;
  });

  const scope = options?.scope || 'full';
  const createdAtIso = options?.createdAt || new Date().toISOString();

  const jsonGenerator = async function* () {
    try {
      const scopePart =
        scope === 'season' && options?.season
          ? `"scope":"season","season":${JSON.stringify(options.season)},`
          : `"scope":"full",`;

      const prefix = `{"formatVersion":"3.0","timestamp":${Date.now()},${scopePart}"tables":`;
      yield Buffer.from(prefix, 'utf8');

      const startTablesChunk = Buffer.from('{', 'utf8');
      yield startTablesChunk;
      tablesHasher.update(startTablesChunk);

      let isFirstTable = true;

      for (const tableName of MANDATORY_BACKUP_TABLES) {
        tableCounts[tableName] = 0;

        const tableKeyPrefix = `${isFirstTable ? '' : ','}"${tableName}":[`;
        const tableKeyChunk = Buffer.from(tableKeyPrefix, 'utf8');
        yield tableKeyChunk;
        tablesHasher.update(tableKeyChunk);

        isFirstTable = false;

        let isFirstRow = true;
        const pageIterable = pageIteratorProvider(tableName);

        for await (const page of pageIterable) {
          if (!Array.isArray(page) || page.length === 0) continue;

          for (const row of page) {
            const rowJson = JSON.stringify(row);
            const rowChunk = Buffer.from(`${isFirstRow ? '' : ','}${rowJson}`, 'utf8');
            yield rowChunk;
            tablesHasher.update(rowChunk);

            isFirstRow = false;
            tableCounts[tableName]++;
          }
        }

        const tableEndChunk = Buffer.from(']', 'utf8');
        yield tableEndChunk;
        tablesHasher.update(tableEndChunk);
      }

      const endTablesChunk = Buffer.from('}', 'utf8');
      yield endTablesChunk;
      tablesHasher.update(endTablesChunk);

      const checksum = tablesHasher.digest('hex');
      resolveChecksum(checksum);
      resolveCounts(tableCounts);

      const manifest: BackupManifestV3 = {
        formatVersion: '3.0',
        createdAt: createdAtIso,
        environment: process.env.NODE_ENV || 'development',
        schemaVersion: '3.0',
        checksumAlgorithm: 'sha256',
        checksum,
        compression: 'gzip',
        tables: tableCounts,
        scope,
        season: options?.season,
      };
      resolveManifest(manifest);

      const suffix = `,"manifest":${JSON.stringify(manifest)}}`;
      yield Buffer.from(suffix, 'utf8');
    } catch (err) {
      rejectChecksum(err);
      rejectCounts(err);
      rejectManifest(err);
      throw err;
    }
  };

  const rawStream = Readable.from(jsonGenerator());
  const gzipStream = zlib.createGzip({ level: 6 });

  pipeline(rawStream, gzipStream, (err) => {
    if (err) {
      rejectChecksum(err);
      rejectCounts(err);
      rejectManifest(err);
    }
  });

  return {
    stream: gzipStream,
    checksumPromise,
    tableCountsPromise,
    manifestPromise,
  };
}

export function createV4BackupStream(
  plan: BackupPlan,
  pageIteratorProvider: (tableName: PersistentBackupTableName) => AsyncIterable<any[]>,
  options?: { createdAt?: string },
): {
  stream: Readable;
  checksumPromise: Promise<string>;
  tableCountsPromise: Promise<Record<string, number>>;
  manifestPromise: Promise<BackupManifestV4>;
} {
  const tableCounts: Record<string, number> = {};
  const tablesHasher = crypto.createHash('sha256');
  const createdAt = options?.createdAt || new Date().toISOString();

  let resolveChecksum!: (value: string) => void;
  let rejectChecksum!: (reason: unknown) => void;
  const checksumPromise = new Promise<string>((resolve, reject) => {
    resolveChecksum = resolve;
    rejectChecksum = reject;
  });

  let resolveCounts!: (value: Record<string, number>) => void;
  let rejectCounts!: (reason: unknown) => void;
  const tableCountsPromise = new Promise<Record<string, number>>((resolve, reject) => {
    resolveCounts = resolve;
    rejectCounts = reject;
  });

  let resolveManifest!: (value: BackupManifestV4) => void;
  let rejectManifest!: (reason: unknown) => void;
  const manifestPromise = new Promise<BackupManifestV4>((resolve, reject) => {
    resolveManifest = resolve;
    rejectManifest = reject;
  });

  const planSummary = {
    scope: plan.scope,
    module: plan.module,
    selector: plan.selector,
    tables: plan.tables.map(({ tableName, role }) => ({ tableName, role })),
    externalDependencies: plan.externalDependencies,
  };
  const planDigest = crypto.createHash('sha256').update(JSON.stringify(planSummary)).digest('hex');

  const jsonGenerator = async function* () {
    try {
      const prefix = `{"formatVersion":"4.0","timestamp":${Date.now()},"scope":"${plan.scope}","tables":`;
      yield Buffer.from(prefix, 'utf8');

      const startTables = Buffer.from('{', 'utf8');
      yield startTables;
      tablesHasher.update(startTables);

      for (let tableIndex = 0; tableIndex < plan.tables.length; tableIndex++) {
        const { tableName } = plan.tables[tableIndex];
        tableCounts[tableName] = 0;
        const tableStart = Buffer.from(`${tableIndex === 0 ? '' : ','}"${tableName}":[`, 'utf8');
        yield tableStart;
        tablesHasher.update(tableStart);

        let firstRow = true;
        for await (const page of pageIteratorProvider(tableName)) {
          if (!Array.isArray(page)) throw new TypeError(`表 ${tableName} 的分页结果必须为数组`);
          for (const row of page) {
            const rowChunk = Buffer.from(`${firstRow ? '' : ','}${JSON.stringify(row)}`, 'utf8');
            yield rowChunk;
            tablesHasher.update(rowChunk);
            firstRow = false;
            tableCounts[tableName]++;
          }
        }

        const tableEnd = Buffer.from(']', 'utf8');
        yield tableEnd;
        tablesHasher.update(tableEnd);
      }

      const endTables = Buffer.from('}', 'utf8');
      yield endTables;
      tablesHasher.update(endTables);

      const checksum = tablesHasher.digest('hex');
      const tableRoles = Object.fromEntries(
        plan.tables.map(({ tableName, role }) => [tableName, role]),
      ) as BackupManifestV4['tableRoles'];
      const manifest: BackupManifestV4 = {
        formatVersion: '4.0',
        createdAt,
        environment: process.env.NODE_ENV || 'development',
        schemaVersion: '4.0',
        checksumAlgorithm: 'sha256',
        checksum,
        compression: 'gzip',
        scope: plan.scope,
        module: plan.module,
        selector: { ...plan.selector },
        tables: { ...tableCounts },
        tableRoles,
        externalDependencies: [...plan.externalDependencies],
        planDigest,
      };

      resolveChecksum(checksum);
      resolveCounts({ ...tableCounts });
      resolveManifest(manifest);
      yield Buffer.from(`,"manifest":${JSON.stringify(manifest)}}`, 'utf8');
    } catch (error) {
      rejectChecksum(error);
      rejectCounts(error);
      rejectManifest(error);
      throw error;
    }
  };

  const rawStream = Readable.from(jsonGenerator());
  const gzipStream = zlib.createGzip({ level: 6 });
  pipeline(rawStream, gzipStream, (error) => {
    if (error) {
      rejectChecksum(error);
      rejectCounts(error);
      rejectManifest(error);
    }
  });

  return { stream: gzipStream, checksumPromise, tableCountsPromise, manifestPromise };
}
