import { Readable, Transform, pipeline } from 'stream';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { BackupStagingStore } from './backup-staging-store';
import {
  MANDATORY_BACKUP_TABLES,
  MandatoryBackupTableName,
  TABLE_METADATA_MAP,
} from './backup-table-registry';
import { BackupScope } from './backup-scope.service';

// CommonJS require 兼容 stream-json
// eslint-disable-next-line @typescript-eslint/no-var-requires
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StreamJsonParser = require('stream-json/Parser');

export interface BackupManifestV3 {
  formatVersion: string;
  createdAt: string;
  environment: string;
  schemaVersion: string;
  checksumAlgorithm: string;
  checksum: string;
  compression: string;
  tables: Record<string, number>;
  scope?: BackupScope;
  season?: { id: string; name: string };
}

export interface PrepareV3StreamOptions {
  createdAt?: string;
  scope?: BackupScope;
  season?: { id: string; name: string };
}

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

export interface ParseStreamResult {
  manifest?: BackupManifestV3;
  formatVersion: string;
  timestamp?: number;
  scope: BackupScope;
  season?: { id: string; name: string };
  fileSha256: string;
  compressedSize: number;
  decompressedSize: number;
  computedChecksum: string;
  tableCounts: Record<string, number>;
  stagingStore: BackupStagingStore;
  cleanup: () => void;
}

function isValidIsoDate(str: any): boolean {
  if (typeof str !== 'string') return false;
  const d = new Date(str);
  return !isNaN(d.getTime()) && str.includes('T');
}

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'formatVersion',
  'timestamp',
  'scope',
  'season',
  'tables',
  'manifest',
]);

const ALLOWED_MANIFEST_KEYS = new Set([
  'formatVersion',
  'createdAt',
  'environment',
  'schemaVersion',
  'checksumAlgorithm',
  'checksum',
  'compression',
  'scope',
  'tables',
  'season',
]);

/**
 * 流式解包、零 packing 字节计数、全方位多层防御性校验与暂存
 */
export async function parseAndValidateBackupStream(
  inputStream: Readable,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _filename?: string,
): Promise<ParseStreamResult> {
  const maxCompressedBytes = parseInt(process.env.BACKUP_MAX_COMPRESSED_BYTES || '104857600', 10);
  const maxDecompressedBytes = parseInt(
    process.env.BACKUP_MAX_UNCOMPRESSED_BYTES || '209715200',
    10,
  );
  const maxRecordBytes = parseInt(process.env.BACKUP_MAX_RECORD_BYTES || '5242880', 10);

  const stagingStore = new BackupStagingStore();

  let rawCompressedBytes = 0;
  let rawDecompressedBytes = 0;
  const fileHasher = crypto.createHash('sha256');

  const sniffChunks: Buffer[] = [];
  let sniffedBytes = 0;
  const SNIFF_SIZE = 10;

  const readSniffPromise = new Promise<boolean>((resolve, reject) => {
    const onData = (chunk: any) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      sniffChunks.push(buf);
      sniffedBytes += buf.length;
      if (sniffedBytes >= SNIFF_SIZE) {
        cleanupSniff();
        resolve(true);
      }
    };
    const onEnd = () => {
      cleanupSniff();
      resolve(false);
    };
    const onError = (err: Error) => {
      cleanupSniff();
      reject(err);
    };
    const cleanupSniff = () => {
      inputStream.off('data', onData);
      inputStream.off('end', onEnd);
      inputStream.off('error', onError);
    };

    inputStream.on('data', onData);
    inputStream.on('end', onEnd);
    inputStream.on('error', onError);
  });

  const hasSniffData = await readSniffPromise;
  if (!hasSniffData && sniffedBytes === 0) {
    stagingStore.cleanup();
    throw new BadRequestException('备份文件为空');
  }

  const sniffBuffer = Buffer.concat(sniffChunks);
  const isGzip = sniffBuffer.length >= 2 && sniffBuffer[0] === 0x1f && sniffBuffer[1] === 0x8b;

  const sniffedStream = Readable.from(
    (async function* () {
      yield sniffBuffer;
      for await (const chunk of inputStream) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      }
    })(),
  );

  const rawMeter = new Transform({
    transform(chunk, encoding, callback) {
      rawCompressedBytes += chunk.length;
      fileHasher.update(chunk);
      if (rawCompressedBytes > maxCompressedBytes) {
        callback(new BadRequestException(`备份压缩文件大小超出限制 (${maxCompressedBytes} 字节)`));
        return;
      }
      callback(null, chunk);
    },
  });

  const decompressedMeter = new Transform({
    transform(chunk, encoding, callback) {
      rawDecompressedBytes += chunk.length;
      if (rawDecompressedBytes > maxDecompressedBytes) {
        callback(
          new BadRequestException(`备份解压后数据大小超出限制 (${maxDecompressedBytes} 字节)`),
        );
        return;
      }
      callback(null, chunk);
    },
  });

  let gunzipStream: zlib.Gunzip | null = null;
  sniffedStream.pipe(rawMeter);
  let lastStream: Readable = rawMeter;
  if (isGzip) {
    gunzipStream = zlib.createGunzip();
    lastStream = lastStream.pipe(gunzipStream);
  }
  lastStream = lastStream.pipe(decompressedMeter);

  const jsonParser = new StreamJsonParser({
    packKeys: false,
    packStrings: false,
    packNumbers: false,
  });
  lastStream.pipe(jsonParser);

  // 上游 Transform 错误触发时立刻销毁 jsonParser 终止 for-await 循环
  rawMeter.on('error', (err) => jsonParser.destroy(err));
  decompressedMeter.on('error', (err) => jsonParser.destroy(err));
  if (gunzipStream) gunzipStream.on('error', (err) => jsonParser.destroy(err));

  const tablesHasher = crypto.createHash('sha256');

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    stagingStore.cleanup();
    sniffedStream.destroy();
    rawMeter.destroy();
    if (gunzipStream) gunzipStream.destroy();
    decompressedMeter.destroy();
    jsonParser.destroy();
  };

  const seenTopLevelKeys = new Set<string>();
  const seenManifestKeys = new Set<string>();
  const seenManifestTableNames = new Set<string>();
  const seenTableNames = new Set<MandatoryBackupTableName>();

  let formatVersion = '';
  let timestamp: number | undefined = undefined;
  let manifest: BackupManifestV3 | undefined = undefined;
  let scope: BackupScope = 'full';
  let seasonInfo: { id: string; name: string } | undefined = undefined;

  const tableCounts: Record<string, number> = {};

  const pathStack: string[] = [];
  let currentKey = '';
  let currentKeyBuffer = '';
  let currentStringChunks: string[] = [];
  let currentNumberChunks: string[] = [];
  let currentTable: MandatoryBackupTableName | null = null;
  let inTablesObject = false;

  let rowTokens: any[] = [];
  let rowByteCount = 0;
  let rowObjectDepth = 0;

  let isFirstTableHasher = true;
  let isFirstRowHasher = true;

  try {
    for await (const token of jsonParser) {
      const { name, value } = token;

      // 根层
      if (pathStack.length === 0) {
        if (name === 'startObject') {
          pathStack.push('root');
          continue;
        }
      }

      // 顶层键构造与防重防未知
      if (pathStack.length === 1 && pathStack[0] === 'root') {
        if (name === 'startKey') {
          currentKey = '';
          currentKeyBuffer = '';
          continue;
        }
        if (
          (name === 'stringChunk' || name === 'keyChunk') &&
          currentKey === '' &&
          !inTablesObject &&
          rowObjectDepth === 0
        ) {
          currentKeyBuffer += value;
          continue;
        }
        if (name === 'endKey') {
          currentKey = currentKeyBuffer;
          currentKeyBuffer = '';
          if (!ALLOWED_TOP_LEVEL_KEYS.has(currentKey)) {
            throw new BadRequestException(`备份数据流包含未知顶层属性: ${currentKey}`);
          }
          if (seenTopLevelKeys.has(currentKey)) {
            throw new BadRequestException(`备份数据流包含重复顶层属性: ${currentKey}`);
          }
          seenTopLevelKeys.add(currentKey);
          continue;
        }

        if (currentKey === 'formatVersion') {
          if (name === 'startString') {
            currentStringChunks = [];
            continue;
          }
          if (name === 'stringChunk') {
            currentStringChunks.push(value);
            continue;
          }
          if (name === 'endString') {
            formatVersion = currentStringChunks.join('');
            currentStringChunks = [];
            currentKey = '';
            continue;
          }
        }

        if (currentKey === 'timestamp') {
          if (name === 'startNumber') {
            currentNumberChunks = [];
            continue;
          }
          if (name === 'numberChunk') {
            currentNumberChunks.push(value);
            continue;
          }
          if (name === 'endNumber') {
            timestamp = parseInt(currentNumberChunks.join(''), 10);
            currentNumberChunks = [];
            currentKey = '';
            continue;
          }
        }

        if (currentKey === 'scope') {
          if (name === 'startString') {
            currentStringChunks = [];
            continue;
          }
          if (name === 'stringChunk') {
            currentStringChunks.push(value);
            continue;
          }
          if (name === 'endString') {
            const scopeVal = currentStringChunks.join('');
            scope = scopeVal === 'season' ? 'season' : 'full';
            currentStringChunks = [];
            currentKey = '';
            continue;
          }
        }

        if (currentKey === 'season' && name === 'startObject') {
          pathStack.push('season');
          seasonInfo = { id: '', name: '' };
          continue;
        }

        if (currentKey === 'manifest' && name === 'startObject') {
          pathStack.push('manifest');
          manifest = {
            formatVersion: '3.0',
            createdAt: '',
            environment: '',
            schemaVersion: '3.0',
            checksumAlgorithm: 'sha256',
            checksum: '',
            compression: 'gzip',
            tables: {},
          };
          continue;
        }

        if (currentKey === 'tables' && name === 'startObject') {
          inTablesObject = true;
          pathStack.push('tables');
          tablesHasher.update('{');
          currentKey = '';
          continue;
        }
      }

      // 解析 season 对象
      if (pathStack.length === 2 && pathStack[1] === 'season' && seasonInfo) {
        if (name === 'startKey') {
          currentKey = '';
          currentKeyBuffer = '';
          continue;
        }
        if ((name === 'stringChunk' || name === 'keyChunk') && currentKey === '') {
          currentKeyBuffer += value;
          continue;
        }
        if (name === 'endKey') {
          currentKey = currentKeyBuffer;
          currentKeyBuffer = '';
          continue;
        }
        if (name === 'startString') {
          currentStringChunks = [];
          continue;
        }
        if (name === 'stringChunk') {
          currentStringChunks.push(value);
          continue;
        }
        if (name === 'endString') {
          const strVal = currentStringChunks.join('');
          if (currentKey === 'id') seasonInfo.id = strVal;
          if (currentKey === 'name') seasonInfo.name = strVal;
          currentStringChunks = [];
          currentKey = '';
          continue;
        }
        if (name === 'endObject') {
          pathStack.pop();
          currentKey = '';
          continue;
        }
      }

      // 解析 manifest 对象
      if (pathStack.length >= 2 && pathStack[1] === 'manifest' && manifest) {
        if (pathStack.length === 2) {
          if (name === 'startKey') {
            currentKey = '';
            currentKeyBuffer = '';
            continue;
          }
          if ((name === 'stringChunk' || name === 'keyChunk') && currentKey === '') {
            currentKeyBuffer += value;
            continue;
          }
          if (name === 'endKey') {
            currentKey = currentKeyBuffer;
            currentKeyBuffer = '';
            if (!ALLOWED_MANIFEST_KEYS.has(currentKey)) {
              throw new BadRequestException(`Manifest 包含未知属性: ${currentKey}`);
            }
            if (seenManifestKeys.has(currentKey)) {
              throw new BadRequestException(`Manifest 包含重复属性: ${currentKey}`);
            }
            seenManifestKeys.add(currentKey);
            continue;
          }
          if (name === 'startString') {
            currentStringChunks = [];
            continue;
          }
          if (name === 'stringChunk') {
            currentStringChunks.push(value);
            continue;
          }
          if (name === 'endString') {
            const strVal = currentStringChunks.join('');
            if (currentKey === 'formatVersion') manifest.formatVersion = strVal;
            if (currentKey === 'createdAt') manifest.createdAt = strVal;
            if (currentKey === 'environment') manifest.environment = strVal;
            if (currentKey === 'schemaVersion') manifest.schemaVersion = strVal;
            if (currentKey === 'checksumAlgorithm') manifest.checksumAlgorithm = strVal;
            if (currentKey === 'checksum') manifest.checksum = strVal;
            if (currentKey === 'compression') manifest.compression = strVal;
            if (currentKey === 'scope') manifest.scope = strVal === 'season' ? 'season' : 'full';
            currentStringChunks = [];
            currentKey = '';
            continue;
          }
          if (currentKey === 'tables' && name === 'startObject') {
            pathStack.push('manifest_tables');
            continue;
          }
          if (currentKey === 'season' && name === 'startObject') {
            pathStack.push('manifest_season');
            manifest.season = { id: '', name: '' };
            continue;
          }
          if (name === 'endObject') {
            pathStack.pop();
            currentKey = '';
            continue;
          }
        } else if (pathStack.length === 3 && pathStack[2] === 'manifest_tables') {
          if (name === 'startKey') {
            currentKey = '';
            currentKeyBuffer = '';
            continue;
          }
          if ((name === 'stringChunk' || name === 'keyChunk') && currentKey === '') {
            currentKeyBuffer += value;
            continue;
          }
          if (name === 'endKey') {
            currentKey = currentKeyBuffer;
            currentKeyBuffer = '';
            if (seenManifestTableNames.has(currentKey)) {
              throw new BadRequestException(`Manifest 表清单包含重复键: ${currentKey}`);
            }
            seenManifestTableNames.add(currentKey);
            continue;
          }
          if (name === 'startNumber') {
            currentNumberChunks = [];
            continue;
          }
          if (name === 'numberChunk') {
            currentNumberChunks.push(value);
            continue;
          }
          if (name === 'endNumber') {
            const cntStr = currentNumberChunks.join('');
            const cnt = parseInt(cntStr, 10);
            if (isNaN(cnt) || cnt < 0) {
              throw new BadRequestException(
                `Manifest.tables 属性 ${currentKey} 包含非法行数: ${cntStr}`,
              );
            }
            manifest.tables[currentKey] = cnt;
            currentKey = '';
            currentNumberChunks = [];
            continue;
          }
          if (name === 'endObject') {
            pathStack.pop();
            currentKey = '';
            continue;
          }
        } else if (
          pathStack.length === 3 &&
          pathStack[2] === 'manifest_season' &&
          manifest.season
        ) {
          if (name === 'startKey') {
            currentKey = '';
            currentKeyBuffer = '';
            continue;
          }
          if ((name === 'stringChunk' || name === 'keyChunk') && currentKey === '') {
            currentKeyBuffer += value;
            continue;
          }
          if (name === 'endKey') {
            currentKey = currentKeyBuffer;
            currentKeyBuffer = '';
            continue;
          }
          if (name === 'startString') {
            currentStringChunks = [];
            continue;
          }
          if (name === 'stringChunk') {
            currentStringChunks.push(value);
            continue;
          }
          if (name === 'endString') {
            const strVal = currentStringChunks.join('');
            if (currentKey === 'id') manifest.season.id = strVal;
            if (currentKey === 'name') manifest.season.name = strVal;
            currentStringChunks = [];
            currentKey = '';
            continue;
          }
          if (name === 'endObject') {
            pathStack.pop();
            currentKey = '';
            continue;
          }
        }
      }

      // 解析 tables 对象
      if (inTablesObject) {
        if (pathStack.length === 2 && pathStack[1] === 'tables') {
          if (name === 'startKey') {
            currentTable = null;
            currentKeyBuffer = '';
            continue;
          }
          if ((name === 'stringChunk' || name === 'keyChunk') && currentTable === null) {
            currentKeyBuffer += value;
            continue;
          }
          if (name === 'endKey') {
            const tName = currentKeyBuffer as MandatoryBackupTableName;
            currentKeyBuffer = '';

            if (!MANDATORY_BACKUP_TABLES.includes(tName)) {
              throw new BadRequestException(`备份数据流包含未知表名: ${tName}`);
            }
            if (seenTableNames.has(tName)) {
              throw new BadRequestException(`备份数据流重复包含表: ${tName}`);
            }
            seenTableNames.add(tName);
            currentTable = tName;

            const prefixStr = `${isFirstTableHasher ? '' : ','}"${currentTable}":[`;
            tablesHasher.update(prefixStr);
            isFirstTableHasher = false;
            isFirstRowHasher = true;
            continue;
          }

          if (name === 'startArray' && currentTable) {
            pathStack.push(`table_${currentTable}`);
            continue;
          }

          if (name === 'endObject') {
            tablesHasher.update('}');
            pathStack.pop();
            inTablesObject = false;
            currentTable = null;
            continue;
          }
        }

        // 解析单张表的数据行 (Array of Objects)
        if (pathStack.length >= 3 && pathStack[1] === 'tables' && currentTable) {
          if (rowObjectDepth === 0 && name === 'startObject') {
            rowObjectDepth = 1;
            rowTokens = [{ name: 'startObject' }];
            rowByteCount = 2; // "{}" 基础字节
            continue;
          }

          if (rowObjectDepth > 0) {
            // Chunk 级 Token 收集与字节统计
            if (name === 'startString' || name === 'startKey') {
              currentStringChunks = [];
              rowByteCount += 1;
            } else if (name === 'startNumber') {
              currentNumberChunks = [];
            } else if (name === 'stringChunk' || name === 'keyChunk') {
              currentStringChunks.push(value);
              rowByteCount += Buffer.byteLength(String(value), 'utf8');
            } else if (name === 'numberChunk') {
              currentNumberChunks.push(value);
              rowByteCount += Buffer.byteLength(String(value), 'utf8');
            } else if (name === 'endKey') {
              const keyVal = currentStringChunks.join('');
              rowTokens.push({ name: 'keyValue', value: keyVal });
              currentStringChunks = [];
              rowByteCount += Buffer.byteLength(keyVal, 'utf8') + 3;
            } else if (name === 'endString') {
              const strVal = currentStringChunks.join('');
              rowTokens.push({ name: 'stringValue', value: strVal });
              currentStringChunks = [];
              rowByteCount += Buffer.byteLength(strVal, 'utf8') + 2;
            } else if (name === 'endNumber') {
              const numStr = currentNumberChunks.join('');
              const numVal = Number(numStr);
              rowTokens.push({ name: 'numberValue', value: numVal });
              currentNumberChunks = [];
            } else if (name === 'trueValue' || name === 'falseValue' || name === 'nullValue') {
              rowTokens.push(token);
              rowByteCount += 4;
            } else if (name === 'startObject' || name === 'startArray') {
              rowTokens.push(token);
              rowObjectDepth++;
              rowByteCount += 1;
            } else if (name === 'endObject' || name === 'endArray') {
              rowTokens.push(token);
              rowObjectDepth--;
              rowByteCount += 1;
            }

            if (rowByteCount > maxRecordBytes) {
              throw new BadRequestException(
                `表 ${currentTable} 包含超出单条记录最大允许上限 (${maxRecordBytes} 字节) 的超大记录`,
              );
            }

            if (rowObjectDepth === 0) {
              // 完整提取一条记录
              const record = assembleObjectFromTokens(rowTokens);
              rowTokens = [];

              // 行级日期校验
              const dateFields = TABLE_METADATA_MAP[currentTable]?.dateFields || [];
              for (const df of dateFields) {
                if (record[df] !== undefined && record[df] !== null) {
                  if (!isValidIsoDate(record[df])) {
                    throw new BadRequestException(
                      `表 ${currentTable} 字段 ${df} 包含无效日期值: ${record[df]}`,
                    );
                  }
                }
              }

              // 写入增量 Hash & 写入 Staging (AWAIT 触发背压挂起!)
              const rowJsonStr = JSON.stringify(record);
              const hasherRowChunk = `${isFirstRowHasher ? '' : ','}${rowJsonStr}`;
              tablesHasher.update(hasherRowChunk);
              isFirstRowHasher = false;

              await stagingStore.writeRow(currentTable, record);

              tableCounts[currentTable] = (tableCounts[currentTable] || 0) + 1;
            }
            continue;
          }

          if (name === 'endArray') {
            tablesHasher.update(']');
            pathStack.pop();
            currentTable = null;
            continue;
          }
        }
      }

      if (pathStack.length === 1 && name === 'endObject') {
        pathStack.pop();
      }
    }

    // 解析完成后的全局完整性断言
    if (seenTableNames.size !== 17) {
      const missingTables = MANDATORY_BACKUP_TABLES.filter((t) => !seenTableNames.has(t));
      throw new BadRequestException(`备份数据流缺失必需表: ${missingTables.join(', ')}`);
    }

    if (manifest) {
      const manifestTableKeys = Object.keys(manifest.tables || {});
      if (manifestTableKeys.length !== 17) {
        throw new BadRequestException('Manifest.tables 必须精确包含 17 张表');
      }
      for (const t of MANDATORY_BACKUP_TABLES) {
        if (
          typeof manifest.tables[t] !== 'number' ||
          manifest.tables[t] < 0 ||
          !Number.isInteger(manifest.tables[t])
        ) {
          throw new BadRequestException(`Manifest.tables 属性 ${t} 包含非法的行数计数`);
        }
      }
    }

    await stagingStore.finishWriting();
    const fileSha256 = fileHasher.digest('hex');
    const computedChecksum = tablesHasher.digest('hex');

    return {
      manifest,
      formatVersion,
      timestamp,
      scope,
      season: seasonInfo,
      fileSha256,
      compressedSize: rawCompressedBytes,
      decompressedSize: rawDecompressedBytes,
      computedChecksum,
      tableCounts,
      stagingStore,
      cleanup,
    };
  } catch (err: any) {
    cleanup();
    if (err instanceof BadRequestException) {
      throw err;
    }
    throw new BadRequestException(`读取备份流失败: ${err?.message || '未知流错误'}`);
  }
}

function assembleObjectFromTokens(tokens: any[]): any {
  let index = 0;

  function parseVal(): any {
    if (index >= tokens.length) return undefined;
    const tok = tokens[index++];
    if (!tok) return undefined;

    if (tok.name === 'startObject') {
      const obj: Record<string, any> = {};
      while (index < tokens.length) {
        if (tokens[index].name === 'endObject') {
          index++;
          break;
        }
        const keyTok = tokens[index++];
        if (!keyTok || keyTok.name !== 'keyValue') break;
        const key = keyTok.value;
        obj[key] = parseVal();
      }
      return obj;
    }

    if (tok.name === 'startArray') {
      const arr: any[] = [];
      while (index < tokens.length) {
        if (tokens[index].name === 'endArray') {
          index++;
          break;
        }
        arr.push(parseVal());
      }
      return arr;
    }

    if (tok.name === 'trueValue') return true;
    if (tok.name === 'falseValue') return false;
    if (tok.name === 'nullValue') return null;

    if (tok.name === 'stringValue' || tok.name === 'numberValue') {
      return tok.value;
    }

    return undefined;
  }

  return parseVal();
}
