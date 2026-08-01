import { Injectable } from '@nestjs/common';
import { BackupMetadata } from './backup.service';

export interface RetentionPlanItem {
  key: string;
  filename: string;
  reason: string;
  lastModified?: Date;
  protected?: boolean;
}

export interface RetentionResult {
  dryRun: boolean;
  plannedDeletions: RetentionPlanItem[];
  keptCount: number;
  deletedCount: number;
}

@Injectable()
export class BackupRetentionService {
  /**
   * 计算按照保留策略应当清理的备份列表
   * 策略：
   * 1. 临时上传 (private-backups/uploads/) 独占生命周期：超过 24 小时进行清理，未超过 24 小时保留，绝不进入数据库正式周/月保留桶；
   * 2. 最新数据库备份绝对保护，禁止清理；
   * 3. 带有 protected 标记或 key/filename 包含 _protected 的备份跳过；
   * 4. 带有 _pre-restore 的备份/前置快照超过 7 天清理；
   * 5. 其余数据库备份按周一 ISO 日期保留最近 4 个周备份和 6 个月备份。
   */
  calculateRetentionPlan(
    backups: BackupMetadata[],
    now: Date = new Date(),
  ): {
    plannedDeletions: RetentionPlanItem[];
    kept: BackupMetadata[];
  } {
    if (!backups || backups.length === 0) {
      return { plannedDeletions: [], kept: [] };
    }

    const sorted = [...backups].sort((a, b) => {
      const timeA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const timeB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return timeB - timeA;
    });

    const newestDbBackupKey = sorted.find((b) => b.key.startsWith('private-backups/database/'))?.key;
    const plannedDeletions: RetentionPlanItem[] = [];
    const kept: BackupMetadata[] = [];

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

    const weeklyMap = new Map<string, BackupMetadata>();
    const monthlyMap = new Map<string, BackupMetadata>();

    const getWeekKey = (d: Date): string => {
      const copy = new Date(d);
      const day = copy.getDay() || 7;
      copy.setDate(copy.getDate() - day + 1);
      return `${copy.getFullYear()}-${String(copy.getMonth() + 1).padStart(2, '0')}-${String(copy.getDate()).padStart(2, '0')}`;
    };

    for (let index = 0; index < sorted.length; index++) {
      const item = sorted[index];
      const itemTime = item.lastModified ? new Date(item.lastModified).getTime() : 0;
      const ageMs = now.getTime() - itemTime;
      const filename = item.filename || item.key.split('/').pop() || '';

      // 1. 临时上传隔离逻辑
      if (item.key.startsWith('private-backups/uploads/')) {
        if (ageMs > TWENTY_FOUR_HOURS_MS) {
          plannedDeletions.push({
            key: item.key,
            filename,
            reason: '临时上传文件超时 24 小时未完成',
            lastModified: item.lastModified,
          });
        } else {
          kept.push(item);
        }
        continue;
      }

      // 2. 最新正式数据库备份保护
      if (item.key === newestDbBackupKey) {
        kept.push(item);
        continue;
      }

      // 3. 受受控 protected 标记保护
      if (item.protected || item.key?.includes('_protected') || filename.includes('_protected')) {
        kept.push(item);
        continue;
      }

      // 4. 恢复前自动快照超 7 天
      if (
        (item.key.includes('_pre-restore') || filename.includes('_pre-restore') || item.key.includes('pre-restore-auto-')) &&
        ageMs > SEVEN_DAYS_MS
      ) {
        plannedDeletions.push({
          key: item.key,
          filename,
          reason: '恢复前前置自动快照超出 7 天保留期限',
          lastModified: item.lastModified,
        });
        continue;
      }

      // 5. 正式数据库备份归类保留
      if (item.lastModified) {
        const d = new Date(item.lastModified);
        const weekKey = getWeekKey(d);
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

        if (!weeklyMap.has(weekKey) && weeklyMap.size < 4) {
          weeklyMap.set(weekKey, item);
          kept.push(item);
          continue;
        }

        if (!monthlyMap.has(monthKey) && monthlyMap.size < 6) {
          monthlyMap.set(monthKey, item);
          kept.push(item);
          continue;
        }
      }

      if (sorted.length - plannedDeletions.length > 2) {
        plannedDeletions.push({
          key: item.key,
          filename,
          reason: '超出最近 4 个周备份与 6 个月备份的保留策略窗口',
          lastModified: item.lastModified,
        });
      } else {
        kept.push(item);
      }
    }

    return { plannedDeletions, kept };
  }
}
