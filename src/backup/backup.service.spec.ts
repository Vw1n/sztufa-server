import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { BackupService } from './backup.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';

jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://r2.example.com/presigned-url'),
}));

describe('BackupService (Phase 2)', () => {
  let service: BackupService;

  const mockPrismaService = {
    $transaction: jest.fn().mockImplementation(async (cb) => {
      return cb(mockPrismaService);
    }),
    user: { findMany: jest.fn().mockResolvedValue([]) },
    team: { findMany: jest.fn().mockResolvedValue([]) },
    player: { findMany: jest.fn().mockResolvedValue([]) },
    match: { findMany: jest.fn().mockResolvedValue([]) },
    prediction: { findMany: jest.fn().mockResolvedValue([]) },
    goal: { findMany: jest.fn().mockResolvedValue([]) },
    matchEvent: { findMany: jest.fn().mockResolvedValue([]) },
    news: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    season: { findMany: jest.fn().mockResolvedValue([]) },
    seasonTeamProfile: { findMany: jest.fn().mockResolvedValue([]) },
    historyImportBatch: { findMany: jest.fn().mockResolvedValue([]) },
    seasonDeletionApproval: { findMany: jest.fn().mockResolvedValue([]) },
    seasonTeamPlayer: { findMany: jest.fn().mockResolvedValue([]) },
    matchLineup: { findMany: jest.fn().mockResolvedValue([]) },
    seasonGroupTeam: { findMany: jest.fn().mockResolvedValue([]) },
    pdfImportBatch: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const mockAuditLogService = {
    log: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AuditLogService, useValue: mockAuditLogService },
      ],
    }).compile();

    service = module.get<BackupService>(BackupService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createBackup', () => {
    it('should query all 17 models and upload backup', async () => {
      const result = await service.createBackup('admin');
      expect(result.key).toMatch(/^private-backups\/database\/backup_/);
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        'admin',
        'CREATE_BACKUP',
        expect.stringContaining('17 个数据模型'),
      );
    });
  });

  describe('restoreBackup safeguards', () => {
    it('should throw ServiceUnavailableException if BACKUP_RESTORE_ENABLED is not true', async () => {
      process.env.BACKUP_RESTORE_ENABLED = 'false';
      await expect(
        service.restoreBackup(
          'admin',
          'private-backups/database/backup_123.json',
          'CONFIRM_RESTORE',
        ),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('should throw BadRequestException if confirmText is not CONFIRM_RESTORE', async () => {
      process.env.BACKUP_RESTORE_ENABLED = 'true';
      await expect(
        service.restoreBackup('admin', 'private-backups/database/backup_123.json', 'WRONG_CONFIRM'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
