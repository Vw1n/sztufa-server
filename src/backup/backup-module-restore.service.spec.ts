import { BadRequestException } from '@nestjs/common';
import { BackupModuleRestoreService } from './backup-module-restore.service';

describe('BackupModuleRestoreService', () => {
  const createService = () => {
    const cleanup = jest.fn();
    const parsed: any = {
      manifest: {
        formatVersion: '4.0',
        scope: 'module',
        module: 'content',
        selector: {},
      },
      formatVersion: '4.0',
      scope: 'module',
      fileSha256: 'a'.repeat(64),
      compressedSize: 100,
      decompressedSize: 300,
      tableCounts: { News: 2 },
      stagingStore: { iterateTable: jest.fn() },
      cleanup,
    };
    const objectStore: any = {
      validateBackupKey: jest.fn(),
      getObjectBody: jest.fn().mockResolvedValue({}),
    };
    const verification: any = { parseAndValidate: jest.fn().mockResolvedValue(parsed) };
    const service = new BackupModuleRestoreService(
      {} as any,
      objectStore,
      verification,
      {} as any,
      {} as any,
    );
    return { service, cleanup };
  };

  beforeEach(() => {
    process.env.JWT_SECRET = 'module-restore-test-secret';
    process.env.BACKUP_RESTORE_ENABLED = 'true';
    process.env.BACKUP_RESTORE_CONTENT_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.BACKUP_RESTORE_ENABLED;
    delete process.env.BACKUP_RESTORE_CONTENT_ENABLED;
  });

  it('Preview 返回影响摘要、可执行状态和短时签名令牌', async () => {
    const { service, cleanup } = createService();

    const preview = await service.preview(
      'admin',
      'private-backups/database/modules/content/a.json.gz',
    );

    expect(preview).toEqual(
      expect.objectContaining({
        module: 'content',
        strategy: 'merge',
        tableCounts: { News: 2 },
        canExecute: true,
        restoreToken: expect.stringMatching(/^[^.]+\.[^.]+$/),
      }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('执行阶段拒绝被篡改的 Preview 令牌', async () => {
    const { service } = createService();
    await expect(
      service.execute(
        'admin',
        'private-backups/database/modules/content/a.json.gz',
        'invalid.token',
        'CONFIRM_MODULE_RESTORE',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
