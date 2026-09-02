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

  it('should NOT delete temp key if referenced in DB via full public URL', async () => {
    const userAKey = `${service.getUserTempPrefix('userA')}logo.webp`;
    const fullUrl = service.getPublicUrl(userAKey);

    // 模拟数据库中通过完整公网 URL 存储了该队徽
    prisma.seasonTeamProfile.findFirst.mockImplementation(async ({ where }: any) => {
      const candidates = where?.OR?.[0]?.teamLogo?.in || [];
      if (candidates.includes(fullUrl) || candidates.includes(userAKey)) {
        return { id: 'profile-1', teamLogo: fullUrl };
      }
      return null;
    });

    const res = await service.cleanupTempKeys([userAKey], 'userA');
    expect(res.cleanedCount).toBe(0);
    expect(service.deleteObject).not.toHaveBeenCalled();
  });

  it('should reject promoting temp assets owned by another user', async () => {
    const userAKey = `${service.getUserTempPrefix('userA')}logo.webp`;
    await expect(service.promoteTempAsset(userAKey, 'teams/team-1/logo', 'userB')).rejects.toThrow(
      '您没有权限使用该临时图片资源',
    );
  });

  it('should promote temp asset when authorized', async () => {
    const userAKey = `${service.getUserTempPrefix('userA')}logo.webp`;
    service.copyObject = jest
      .fn()
      .mockResolvedValue('https://assets.sztufa.xyz/uploads/teams/team-1/logo/new.webp');

    const result = await service.promoteTempAsset(userAKey, 'teams/team-1/logo', 'userA');
    expect(result).toBeDefined();
    expect(result?.isPromoted).toBe(true);
    expect(result?.formalUrl).toContain('uploads/teams/team-1/logo');
    expect(service.copyObject).toHaveBeenCalled();
  });
});
