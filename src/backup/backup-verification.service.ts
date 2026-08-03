import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';
import { BackupObjectStoreService } from './backup-object-store.service';
import { parseAndValidateBackupStream, ParseStreamResult } from './backup-serializer';
import { validateBackupStreamIntegrity, validateForeignKeysFromStaging } from './backup-validator';

/**
 * 备份验证服务。
 * 集中可复用的备份验证流程：解析备份流、校验 manifest / checksum / 文件 SHA-256 / 表数量、
 * 校验暂存数据中的外键，并保证所有成功与失败路径正确释放 staging 资源。
 * 供列表完整性验证、恢复链路与上传完成链路复用。
 */
@Injectable()
export class BackupVerificationService {
  constructor(private readonly objectStore: BackupObjectStoreService) {}

  /**
   * 校验云端备份对象的完整性（解析 + 结构 + checksum + 外键）。
   * 支持通过 integrityMap 在单次请求内缓存校验结果，避免重复下载。
   */
  async verifyBackupIntegrity(key: string, integrityMap?: Map<string, boolean>): Promise<boolean> {
    if (integrityMap && integrityMap.has(key)) {
      return integrityMap.get(key)!;
    }

    let parseResult: ParseStreamResult | null = null;
    try {
      const body = await this.objectStore.getObjectBody(key);
      parseResult = await parseAndValidateBackupStream(body as any);
      validateBackupStreamIntegrity(parseResult);
      await validateForeignKeysFromStaging(parseResult);
      if (integrityMap) integrityMap.set(key, true);
      return true;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        throw err;
      }
      if (integrityMap) integrityMap.set(key, false);
      return false;
    } finally {
      if (parseResult) {
        parseResult.cleanup();
      }
    }
  }

  /**
   * 解析并完整校验备份流。
   * - 解析流（含 staging 落盘）
   * - 若提供 expectedFileSha256，校验文件 SHA-256 一致性（防篡改）
   * - 校验 manifest / checksum / 表计数 / 外键
   *
   * 成功后调用方负责在 finally 中调用返回结果的 cleanup()；
   * 失败时本方法自行清理已创建的 staging 资源再抛出异常。
   */
  async parseAndValidate(
    stream: Readable,
    expectedFileSha256?: string,
  ): Promise<ParseStreamResult> {
    let parseResult: ParseStreamResult | null = null;
    try {
      parseResult = await parseAndValidateBackupStream(stream);

      if (
        expectedFileSha256 &&
        parseResult.fileSha256.toLowerCase() !== expectedFileSha256.toLowerCase()
      ) {
        throw new BadRequestException('上传文件哈希与初始化摘要不一致，数据可能已被篡改');
      }

      validateBackupStreamIntegrity(parseResult);
      await validateForeignKeysFromStaging(parseResult);
      return parseResult;
    } catch (err) {
      if (parseResult) parseResult.cleanup();
      throw err;
    }
  }
}
