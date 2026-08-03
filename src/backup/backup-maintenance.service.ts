import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupRetentionService, RetentionResult } from './backup-retention.service';

/**
 * 备份维护服务。
 * 负责：强确认删除、防止删除受保护/最新备份、计算保留策略、
 * 验证最小可恢复点数量、执行物理删除或 dry-run、记录维护审计日志。
 */
@Injectable()
export class BackupMaintenanceService {
  constructor(
    private readonly objectStore: BackupObjectStoreService,
    private readonly verificationService: BackupVerificationService,
    private readonly retentionService: BackupRetentionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async deleteBackup(username: string, key: string, confirmText?: string): Promise<string> {
    if (confirmText !== 'DELETE_BACKUP') {
      throw new BadRequestException('删除二次确认文本错误，必须为 "DELETE_BACKUP"');
    }

    this.objectStore.validateBackupKey(key);

    const allBackups = await this.objectStore.listBackups();
    if (allBackups.length === 0) {
      throw new BadRequestException('云端不存在可删除的备份文件');
    }

    const targetBackup = allBackups.find((b) => b.key === key);
    if (!targetBackup) {
      throw new BadRequestException(`指定删除的备份文件不存在: ${key}`);
    }

    const targetFilename = targetBackup.filename || targetBackup.key.split('/').pop() || '';
    if (
      targetBackup.protected ||
      targetBackup.key.includes('_protected') ||
      targetFilename.includes('_protected')
    ) {
      throw new BadRequestException('该备份点已被标记为保护，禁止手动删除');
    }

    const fullBackups = allBackups.filter((b) => (b.scope || 'full') === 'full');
    const newestFullKey = fullBackups[0]?.key;

    if (key === newestFullKey) {
      throw new BadRequestException('最新全站备份点已被永久保护，禁止删除');
    }

    const remainingBackups = allBackups.filter((b) => b.key !== key);
    const remainingFullBackups = remainingBackups.filter((b) => (b.scope || 'full') === 'full');

    if (remainingFullBackups.length < 2) {
      throw new BadRequestException('为确保灾备安全，删除后系统必须保留至少 2 个有效全站恢复点');
    }

    const integrityMap = new Map<string, boolean>();
    let validFullCount = 0;

    for (const b of remainingFullBackups) {
      const isValid = await this.verificationService.verifyBackupIntegrity(b.key, integrityMap);
      if (isValid) {
        validFullCount++;
      }
    }

    if (validFullCount < 2) {
      throw new BadRequestException(
        `灾备保护拦截：剩余备份中仅有 ${validFullCount} 个经检验合规可用的全站恢复点（需至少 2 个），拒绝删除！`,
      );
    }

    try {
      await this.objectStore.deleteObject(key);
    } catch (err) {
      console.error('删除对象存储备份失败:', err);
      throw new ServiceUnavailableException('删除云端备份文件失败');
    }

    await this.auditLogService.log(username, 'DELETE_BACKUP', `手动删除云端备份文件: ${key}`);

    return '备份删除成功';
  }

  async cleanRetention(
    username: string,
    dryRun: boolean = true,
    confirmText?: string,
  ): Promise<RetentionResult> {
    const allBackups = await this.objectStore.listBackups({ includeUploads: true });
    const plan = this.retentionService.calculateRetentionPlan(allBackups);

    if (dryRun) {
      return {
        dryRun: true,
        plannedDeletions: plan.plannedDeletions,
        keptCount: plan.kept.length,
        deletedCount: 0,
      };
    }

    if (process.env.BACKUP_RETENTION_DELETE_ENABLED !== 'true') {
      throw new ServiceUnavailableException('自动保留清理删除模式未在环境变量中启用');
    }

    if (confirmText !== 'EXECUTE_RETENTION_DELETE') {
      throw new BadRequestException('执行保留清理物理删除必须确认文本 "EXECUTE_RETENTION_DELETE"');
    }

    const fullBackups = allBackups.filter(
      (b) => b.key.startsWith('private-backups/database/') && (b.scope || 'full') === 'full',
    );
    const newestFullDbKey = fullBackups[0]?.key;

    const hasDatabaseDeletions = plan.plannedDeletions.some((item) =>
      item.key.startsWith('private-backups/database/'),
    );

    const integrityMap = new Map<string, boolean>();
    let validFullDbCount = 0;

    if (hasDatabaseDeletions) {
      for (const dbMeta of fullBackups) {
        const isValid = await this.verificationService.verifyBackupIntegrity(
          dbMeta.key,
          integrityMap,
        );
        if (isValid) validFullDbCount++;
      }
    }

    let deletedCount = 0;

    for (const item of plan.plannedDeletions) {
      if (item.key === newestFullDbKey) continue;

      if (item.key.startsWith('private-backups/database/')) {
        const isFull = !item.key.includes('/seasons/');
        if (isFull) {
          const isItemValid = integrityMap.get(item.key) ?? false;
          const remainingValidCount = validFullDbCount - (isItemValid ? 1 : 0);

          if (remainingValidCount < 2) {
            console.warn(
              `[Retention] 跳过删除 ${item.key}，原因：删后剩余有效全站恢复点数 (${remainingValidCount}) 不足 2 个`,
            );
            continue;
          }
        }
      }

      try {
        await this.objectStore.deleteObject(item.key);
        deletedCount++;

        if (item.key.startsWith('private-backups/database/') && !item.key.includes('/seasons/')) {
          const isItemValid = integrityMap.get(item.key) ?? false;
          if (isItemValid) {
            validFullDbCount--;
          }
        }

        await this.auditLogService.log(
          username,
          'RETENTION_CLEAN_BACKUP',
          `保留策略自动清理备份: ${item.key}，原因: ${item.reason}`,
        );
      } catch (err) {
        console.error(`保留策略删除备份 ${item.key} 失败:`, err);
      }
    }

    const remainingTotal = allBackups.length - deletedCount;

    return {
      dryRun: false,
      plannedDeletions: plan.plannedDeletions,
      keptCount: remainingTotal,
      deletedCount,
    };
  }
}
