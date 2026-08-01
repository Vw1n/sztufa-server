import { Readable, Transform, pipeline } from 'stream';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';

export interface BackupManifestV3 {
  formatVersion: string;
  createdAt: string;
  environment: string;
  schemaVersion: string;
  checksumAlgorithm: string;
  checksum: string;
  compression: string;
  tables: Record<string, number>;
}

export function prepareV3BackupStream(
  tables: Record<string, any[]>,
  options?: {
    createdAt?: string;
  },
): {
  stream: Readable;
  checksum: string;
  tableCounts: Record<string, number>;
} {
  const tableCounts: Record<string, number> = {};
  for (const [tableName, list] of Object.entries(tables)) {
    tableCounts[tableName] = Array.isArray(list) ? list.length : 0;
  }

  // 单次 JSON.stringify(tables)
  const tablesJson = JSON.stringify(tables);
  const checksum = crypto.createHash('sha256').update(tablesJson).digest('hex');

  const manifest: BackupManifestV3 = {
    formatVersion: '3.0',
    createdAt: options?.createdAt || new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    schemaVersion: '3.0',
    checksumAlgorithm: 'sha256',
    checksum,
    compression: 'gzip',
    tables: tableCounts,
  };

  const jsonPrefix = `{"manifest":${JSON.stringify(manifest)},"formatVersion":"3.0","timestamp":${Date.now()},"tables":`;
  const jsonSuffix = `}`;

  const jsonStream = Readable.from([jsonPrefix, tablesJson, jsonSuffix]);
  const gzipStream = jsonStream.pipe(zlib.createGzip());

  return {
    stream: gzipStream,
    checksum,
    tableCounts,
  };
}

export interface ParseResult {
  rawData: any;
  fileSha256: string;
  compressedSize: number;
  decompressedSize: number;
}

/**
 * 辅助从 Readable 流中嗅探前 2 字节以判断 GZIP 魔数 (0x1f, 0x8b)
 */
async function sniffGzipMagic(
  inputStream: Readable,
): Promise<{ isGzip: boolean; stream: Readable }> {
  return new Promise((resolve, reject) => {
    let handled = false;

    const onData = (chunk: Buffer) => {
      if (handled) return;
      handled = true;

      inputStream.off('data', onData);
      inputStream.off('error', onError);
      inputStream.pause();

      const isGzip = chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b;
      const combinedStream = Readable.from(
        (async function* () {
          yield chunk;
          for await (const restChunk of inputStream) {
            yield restChunk;
          }
        })(),
      );

      resolve({ isGzip, stream: combinedStream });
    };

    const onError = (err: Error) => {
      if (handled) return;
      handled = true;
      reject(err);
    };

    inputStream.once('data', onData);
    inputStream.once('error', onError);
    inputStream.once('end', () => {
      if (handled) return;
      handled = true;
      resolve({ isGzip: false, stream: Readable.from([]) });
    });
  });
}

export async function parseAndValidateBackupStream(
  inputStream: Readable,
  filename: string,
): Promise<ParseResult> {
  const maxCompressedBytes = parseInt(
    process.env.BACKUP_MAX_COMPRESSED_BYTES || '104857600',
    10,
  );
  const maxDecompressedBytes = parseInt(
    process.env.BACKUP_MAX_UNCOMPRESSED_BYTES || '209715200',
    10,
  );

  const { isGzip, stream: sniffedStream } = await sniffGzipMagic(inputStream);
  const isExtensionGzip = filename.endsWith('.json.gz');
  const shouldDecompress = isGzip || isExtensionGzip;

  const rawFileMaxBytes = shouldDecompress ? maxCompressedBytes : maxDecompressedBytes;

  return new Promise((resolve, reject) => {
    let rawCompressedBytes = 0;
    let rawDecompressedBytes = 0;
    const fileHasher = crypto.createHash('sha256');
    let rejected = false;

    const rawMeter = new Transform({
      transform(chunk, encoding, callback) {
        rawCompressedBytes += chunk.length;
        if (rawCompressedBytes > rawFileMaxBytes) {
          const err = new BadRequestException(
            `备份原始文件体积 (${rawCompressedBytes} 字节) 超过允许上限 (${rawFileMaxBytes} 字节)`,
          );
          doReject(err);
          return callback(err);
        }
        fileHasher.update(chunk);
        callback(null, chunk);
      },
    });

    const decompressedMeter = new Transform({
      transform(chunk, encoding, callback) {
        rawDecompressedBytes += chunk.length;
        if (rawDecompressedBytes > maxDecompressedBytes) {
          const err = new BadRequestException(
            `备份解压后体积 (${rawDecompressedBytes} 字节) 超过最大允许上限 (${maxDecompressedBytes} 字节) (Zip Bomb 拦截)`,
          );
          doReject(err);
          return callback(err);
        }
        callback(null, chunk);
      },
    });

    let gunzipStream: zlib.Gunzip | null = null;
    const streamPipeline: any[] = [sniffedStream, rawMeter];

    if (shouldDecompress) {
      gunzipStream = zlib.createGunzip();
      gunzipStream.on('error', (err) => {
        doReject(new BadRequestException(`GZIP 解压失败: ${err.message}`));
      });
      streamPipeline.push(gunzipStream);
    }

    streamPipeline.push(decompressedMeter);

    const doReject = (err: any) => {
      if (rejected) return;
      rejected = true;

      sniffedStream.destroy();
      rawMeter.destroy();
      if (gunzipStream) gunzipStream.destroy();
      decompressedMeter.destroy();

      reject(
        err instanceof BadRequestException
          ? err
          : new BadRequestException(`读取备份流失败: ${err?.message || '未知流错误'}`),
      );
    };

    rawMeter.on('error', doReject);
    decompressedMeter.on('error', doReject);
    sniffedStream.on('error', doReject);

    const decompressedChunks: Buffer[] = [];
    decompressedMeter.on('data', (chunk: Buffer) => {
      decompressedChunks.push(chunk);
    });

    pipeline(streamPipeline as any, (err) => {
      if (err) {
        doReject(err);
        return;
      }
      if (rejected) return;

      const fileSha256 = fileHasher.digest('hex');
      const decompressedBuffer = Buffer.concat(decompressedChunks);
      const jsonStr = decompressedBuffer.toString('utf8');

      let rawData: any;
      try {
        rawData = JSON.parse(jsonStr);
      } catch (parseErr: any) {
        return doReject(
          new BadRequestException(`备份文件内容不是有效的 JSON 结构: ${parseErr.message}`),
        );
      }

      resolve({
        rawData,
        fileSha256,
        compressedSize: rawCompressedBytes,
        decompressedSize: rawDecompressedBytes,
      });
    });
  });
}
