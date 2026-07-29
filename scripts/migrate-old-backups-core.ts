import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import * as crypto from 'crypto';
import { classifyBackupContent } from '../src/backup/backup-validator';

/** 纯流式计算体积与 SHA-256 哈希，无内存缓冲 */
export async function getStreamHashAndSize(stream: any): Promise<{ hash: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    stream.on('data', (chunk: any) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve({ hash: hash.digest('hex'), size });
    });
  });
}

/** 有明确容量上限 (默认 50MB) 的分类内容读取器 */
export async function readStreamContentLimited(
  stream: any,
  maxBytes: number = 50 * 1024 * 1024,
): Promise<{ contentStr: string; byteSize: number; isOversized: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteSize = 0;
    let isOversized = false;

    stream.on('data', (chunk: any) => {
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        isOversized = true;
        stream.destroy();
        resolve({ contentStr: '', byteSize, isOversized: true });
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.on('error', (err: any) => {
      if (isOversized) return;
      reject(err);
    });
    stream.on('end', () => {
      if (isOversized) return;
      resolve({
        contentStr: Buffer.concat(chunks).toString('utf-8'),
        byteSize,
        isOversized: false,
      });
    });
  });
}

export interface MigrationMachineOptions {
  isDryRun: boolean;
  isCopy: boolean;
  isVerify: boolean;
  isDeleteSource: boolean;
  confirmDeleteText: string;
  maxSizeBytes?: number;
}

export interface ClassificationRecord {
  targetKey: string;
  category: 'active' | 'legacy-archive' | 'quarantine';
  reason: string;
  hash: string;
  size: number;
}

export function encodeCopySource(bucket: string, key: string): string {
  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${encodeURIComponent(bucket)}/${encodedKey}`;
}

export async function executeMigrationMachine(
  s3Client: S3Client,
  bucket: string,
  options: MigrationMachineOptions,
): Promise<{
  sourceObjects: { Key: string; Size: number }[];
  classifications: Record<string, ClassificationRecord>;
  success: boolean;
}> {
  const {
    isDryRun,
    isCopy,
    isVerify,
    isDeleteSource,
    confirmDeleteText,
    maxSizeBytes = 50 * 1024 * 1024,
  } = options;

  if (isDeleteSource && confirmDeleteText !== 'DELETE_VERIFIED_OLD_BACKUPS') {
    throw new Error(
      '[安全拦截] 删除源对象缺少显式确认文本，需指定 --confirm-delete=DELETE_VERIFIED_OLD_BACKUPS',
    );
  }

  // 1. 盘点源 backups/ 目录（带 ListObjectsV2 分页支持）
  const sourceObjects: { Key: string; Size: number }[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const sourceList = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'backups/',
        ContinuationToken: continuationToken,
      }),
    );

    const pageObjects = (sourceList.Contents || [])
      .filter((o) => o.Key && o.Key.endsWith('.json'))
      .map((o) => ({ Key: o.Key!, Size: o.Size || 0 }));

    sourceObjects.push(...pageObjects);
    continuationToken = sourceList.NextContinuationToken;
  } while (continuationToken);

  if (sourceObjects.length === 0) {
    return { sourceObjects: [], classifications: {}, success: true };
  }

  // 2. 读取并分类所有源对象 (使用真实全量尺寸 fullSize 避免超限误判)
  const classifications: Record<string, ClassificationRecord> = {};

  for (const obj of sourceObjects) {
    const sourceRes = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
    const { contentStr, byteSize, isOversized } = await readStreamContentLimited(
      sourceRes.Body,
      maxSizeBytes,
    );

    let classificationResult;
    if (isOversized) {
      classificationResult = {
        category: 'quarantine' as const,
        reason: `超出最大允许容量限制 (${maxSizeBytes} bytes)`,
      };
    } else {
      classificationResult = classifyBackupContent(contentStr, byteSize, maxSizeBytes);
    }

    const filename = obj.Key.replace('backups/', '');
    let targetPrefix = 'private-backups/database/';
    if (classificationResult.category === 'legacy-archive') {
      targetPrefix = 'private-backups/legacy-archive/';
    } else if (classificationResult.category === 'quarantine') {
      targetPrefix = 'private-backups/quarantine/';
    }

    const targetKey = `${targetPrefix}${filename}`;

    // 单独流式读取计算完整无截断的容量 fullSize 与哈希 hash
    const streamRes = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
    const { hash, size: fullSize } = await getStreamHashAndSize(streamRes.Body);

    classifications[obj.Key] = {
      targetKey,
      category: classificationResult.category,
      reason: classificationResult.reason,
      hash,
      size: fullSize, // 修复：使用纯流式测算获得的真实全量体积 fullSize
    };
  }

  // 3. Dry-Run 模式：零写零删
  if (isDryRun) {
    return { sourceObjects, classifications, success: true };
  }

  // 4. Copy 模式
  if (isCopy) {
    for (const obj of sourceObjects) {
      const { targetKey, hash: sourceHash, size: sourceSize } = classifications[obj.Key];

      try {
        const targetRes = await s3Client.send(
          new GetObjectCommand({ Bucket: bucket, Key: targetKey }),
        );
        const targetMeta = await getStreamHashAndSize(targetRes.Body);

        if (targetMeta.size === sourceSize && targetMeta.hash === sourceHash) {
          continue;
        } else {
          throw new Error(
            `[安全拦截] 目标对象 ${targetKey} 已存在但 SHA-256 不符合 (目标 ${targetMeta.hash} vs 源 ${sourceHash})，禁止静默覆盖！`,
          );
        }
      } catch (err: any) {
        if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
          throw err;
        }
      }

      await s3Client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: encodeCopySource(bucket, obj.Key),
          Key: targetKey,
        }),
      );
    }
  }

  // 5. Verify 模式
  let allVerified = true;
  if (isVerify || isDeleteSource) {
    for (const obj of sourceObjects) {
      const { targetKey, hash: sourceHash, size: sourceSize } = classifications[obj.Key];

      try {
        const sourceRes = await s3Client.send(
          new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
        );
        const targetRes = await s3Client.send(
          new GetObjectCommand({ Bucket: bucket, Key: targetKey }),
        );

        const sourceMeta = await getStreamHashAndSize(sourceRes.Body);
        const targetMeta = await getStreamHashAndSize(targetRes.Body);

        const sizeMatches = sourceSize === targetMeta.size && sourceMeta.size === targetMeta.size;
        const hashMatches = sourceHash === targetMeta.hash && sourceMeta.hash === targetMeta.hash;

        if (!sizeMatches || !hashMatches) {
          allVerified = false;
        }
      } catch {
        allVerified = false;
      }
    }

    if (!allVerified) {
      if (isDeleteSource) {
        throw new Error('[安全拦截] 因校验未全部通过，拒绝执行源文件删除！');
      }
      return { sourceObjects, classifications, success: false };
    }
  }

  // 6. Delete Source 模式
  if (isDeleteSource) {
    if (!allVerified) {
      throw new Error('[安全拦截] 目标副本未经成功验证，拒绝物理删除！');
    }

    for (const obj of sourceObjects) {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: obj.Key,
        }),
      );

      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: obj.Key }));
        throw new Error(`[删除失败] 物理删除指令发出后，源对象仍存在: ${obj.Key}`);
      } catch (err: any) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
          // 清除确认
        } else {
          throw err;
        }
      }
    }
  }

  return { sourceObjects, classifications, success: allVerified };
}
