import { BackupRetentionService } from './backup-retention.service';
import { BackupMetadata } from './backup.types';

describe('BackupRetentionService 模块保留策略', () => {
  const service = new BackupRetentionService();
  const now = new Date('2026-09-09T12:00:00.000Z');

  const moduleBackup = (
    key: string,
    module: BackupMetadata['module'],
    lastModified: Date,
    seasonId?: string,
  ): BackupMetadata => ({
    key,
    filename: key.split('/').pop() || key,
    size: 1,
    lastModified,
    scope: 'module',
    module,
    seasonId,
    selector: seasonId ? { seasonId } : {},
  });

  it('为不同模块分别保留最近备份', () => {
    const staff = moduleBackup(
      'private-backups/database/modules/staff/staff.json.gz',
      'staff',
      now,
    );
    const members = moduleBackup(
      'private-backups/database/modules/members/members.json.gz',
      'members',
      now,
    );

    const plan = service.calculateRetentionPlan([staff, members], now);

    expect(plan.kept).toEqual(expect.arrayContaining([staff, members]));
    expect(plan.plannedDeletions).toHaveLength(0);
  });

  it('为不同赛季 selector 分别保留最近备份', () => {
    const seasonOne = moduleBackup(
      'private-backups/database/modules/season/s1/s1.json.gz',
      'season',
      now,
      's1',
    );
    const seasonTwo = moduleBackup(
      'private-backups/database/modules/season/s2/s2.json.gz',
      'season',
      now,
      's2',
    );

    const plan = service.calculateRetentionPlan([seasonOne, seasonTwo], now);

    expect(plan.kept).toEqual(expect.arrayContaining([seasonOne, seasonTwo]));
    expect(plan.plannedDeletions).toHaveLength(0);
  });
});
