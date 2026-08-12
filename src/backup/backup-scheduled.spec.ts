import { BackupService } from './backup.service';

describe('BackupService scheduled backup interval guard', () => {
  const createService = (backups: any[] = []) => {
    const exportService = { createBackup: jest.fn().mockResolvedValue({ key: 'new-backup' }) };
    const objectStore = { listBackups: jest.fn().mockResolvedValue(backups) };
    const prismaModels = [
      'team',
      'player',
      'match',
      'news',
      'season',
      'prediction',
      'seasonTeamProfile',
      'adminFormDraft',
      'goal',
      'matchEvent',
      'seasonTeamPlayer',
    ];
    const prisma = Object.fromEntries(
      prismaModels.map((model) => [
        model,
        { aggregate: jest.fn().mockResolvedValue({ _max: {} }) },
      ]),
    );
    const service = new BackupService(
      exportService as any,
      {} as any,
      {} as any,
      {} as any,
      objectStore as any,
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
    );
    return { service, exportService, objectStore, prisma };
  };

  afterEach(() => {
    delete process.env.SCHEDULED_BACKUP_MIN_INTERVAL_HOURS;
    delete process.env.SCHEDULED_BACKUP_CHANGE_DETECTION_ENABLED;
  });

  it('reuses a recent scheduled backup without reading the database again', async () => {
    process.env.SCHEDULED_BACKUP_MIN_INTERVAL_HOURS = '144';
    const existing = {
      key: 'private-backups/database/full/recent_scheduled.json.gz',
      filename: 'recent_scheduled.json.gz',
      size: 100,
      purpose: 'scheduled',
      scope: 'full',
      lastModified: new Date(),
    };
    const { service, exportService } = createService([existing]);

    await expect(service.createScheduledBackup('cron')).resolves.toEqual(existing);
    expect(exportService.createBackup).not.toHaveBeenCalled();
  });

  it('creates a scheduled backup when the previous one is outside the interval', async () => {
    process.env.SCHEDULED_BACKUP_MIN_INTERVAL_HOURS = '24';
    const old = {
      key: 'private-backups/database/full/old_scheduled.json.gz',
      purpose: 'scheduled',
      scope: 'full',
      lastModified: new Date(Date.now() - 48 * 60 * 60 * 1000),
    };
    const { service, exportService, prisma } = createService([old]);
    prisma.match.aggregate.mockResolvedValue({ _max: { updatedAt: new Date() } });

    await service.createScheduledBackup('cron');
    expect(exportService.createBackup).toHaveBeenCalledWith('cron', { purpose: 'scheduled' });
  });

  it('skips an old scheduled backup when no business table changed afterward', async () => {
    process.env.SCHEDULED_BACKUP_MIN_INTERVAL_HOURS = '24';
    const backupTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const existing = {
      key: 'private-backups/database/full/unchanged_scheduled.json.gz',
      purpose: 'scheduled',
      scope: 'full',
      lastModified: backupTime,
    };
    const { service, exportService, prisma } = createService([existing]);
    prisma.match.aggregate.mockResolvedValue({
      _max: { updatedAt: new Date(backupTime.getTime() - 1000) },
    });

    await expect(service.createScheduledBackup('cron')).resolves.toEqual(existing);
    expect(exportService.createBackup).not.toHaveBeenCalled();
  });
});
