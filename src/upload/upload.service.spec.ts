import { Test, TestingModule } from '@nestjs/testing';
import { UploadService } from './upload.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UploadService', () => {
  let service: UploadService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      team: { findFirst: jest.fn() },
      player: { findFirst: jest.fn() },
      seasonTeamProfile: { findFirst: jest.fn() },
      seasonTeamPlayer: { findFirst: jest.fn() },
      adminFormDraft: { findMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UploadService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UploadService>(UploadService);
    service.deleteObject = jest.fn().mockResolvedValue(undefined);
  });

  it('should generate deterministic user temp prefix', () => {
    const p1 = service.getUserTempPrefix('userA');
    const p2 = service.getUserTempPrefix('userA');
    const p3 = service.getUserTempPrefix('userB');
    expect(p1).toBe(p2);
    expect(p1).not.toBe(p3);
    expect(p1.startsWith('temp/user_')).toBe(true);
  });

  it('should prevent user B from deleting temp keys belonging to user A', async () => {
    const userAKey = `${service.getUserTempPrefix('userA')}123.webp`;
    prisma.adminFormDraft.findMany.mockResolvedValue([]);

    const res = await service.cleanupTempKeys([userAKey], 'userB');
    expect(res.cleanedCount).toBe(0);
    expect(service.deleteObject).not.toHaveBeenCalled();
  });

  it('should clean up key when belonging to user A and unreferenced in other drafts or official tables', async () => {
    const userAKey = `${service.getUserTempPrefix('userA')}123.webp`;
    prisma.adminFormDraft.findMany.mockResolvedValue([]);

    const res = await service.cleanupTempKeys([userAKey], 'userA', { excludedDraftId: 'draft-1' });
    expect(res.cleanedCount).toBe(1);
    expect(service.deleteObject).toHaveBeenCalledWith(userAKey);
  });
});
