import { Test, TestingModule } from '@nestjs/testing';
import { FormDraftService } from './form-draft.service';
import { PrismaService } from '../prisma/prisma.service';
import { TeamService } from '../team/team.service';
import { MatchService } from '../match/match.service';
import { UploadService } from '../upload/upload.service';

describe('FormDraftService', () => {
  let service: FormDraftService;
  let prisma: any;
  let teamService: any;
  let matchService: any;
  let uploadService: any;

  beforeEach(async () => {
    prisma = {
      adminFormDraft: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        delete: jest.fn(),
      },
      season: {
        findFirst: jest.fn(),
      },
      team: { findFirst: jest.fn() },
      player: { findFirst: jest.fn() },
      seasonTeamProfile: { findFirst: jest.fn() },
      seasonTeamPlayer: { findFirst: jest.fn() },
      $transaction: jest.fn(async (cb) => cb(prisma)),
    };

    teamService = {
      createTeamCore: jest.fn(),
      updateWithPlayers: jest.fn(),
      afterTeamCommitted: jest.fn(),
    };

    matchService = {
      createMatchCore: jest.fn(),
      update: jest.fn(),
      afterMatchCommitted: jest.fn(),
    };

    uploadService = {
      extractKeyFromUrl: jest.fn((url) => url),
      deleteObject: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FormDraftService,
        { provide: PrismaService, useValue: prisma },
        { provide: TeamService, useValue: teamService },
        { provide: MatchService, useValue: matchService },
        { provide: UploadService, useValue: uploadService },
      ],
    }).compile();

    service = module.get<FormDraftService>(FormDraftService);
  });

  it('should save raw payload as draft without materializing', async () => {
    const mockDraft = {
      id: 'draft-1',
      formType: 'TEAM',
      payload: { teamName: '' },
      status: 'DRAFT',
    };
    prisma.adminFormDraft.create.mockResolvedValue(mockDraft);

    const res = await service.saveDraft({ formType: 'TEAM', payload: { teamName: '' } }, 'admin');
    expect(res.draftId).toBe('draft-1');
    expect(res.saveStatus).toBe('DRAFT');
    expect(teamService.createTeamCore).not.toHaveBeenCalled();
  });

  it('should prevent materializing an empty team draft', async () => {
    prisma.adminFormDraft.updateMany.mockResolvedValue({ count: 1 });
    prisma.adminFormDraft.findUnique.mockResolvedValue({
      id: 'draft-1',
      formType: 'TEAM',
      payload: { teamName: '   ' },
      seasonId: null,
      officialRecordId: null,
    });

    const res = await service.tryMaterialize('draft-1', 'admin');
    expect(res.success).toBe(false);
    expect(res.error).toContain('缺少球队基本信息');
    expect(teamService.createTeamCore).not.toHaveBeenCalled();
    expect(prisma.adminFormDraft.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { status: 'DRAFT' },
    });
  });

  it('should atomically materialize a valid team draft and call afterTeamCommitted', async () => {
    prisma.adminFormDraft.updateMany.mockResolvedValue({ count: 1 });
    prisma.adminFormDraft.findUnique.mockResolvedValue({
      id: 'draft-1',
      formType: 'TEAM',
      payload: { teamName: '软件工程足球队' },
      seasonId: 'season-1',
      officialRecordId: null,
    });
    teamService.createTeamCore.mockResolvedValue({ id: 'team-100', teamName: '软件工程足球队' });

    const res = await service.tryMaterialize('draft-1', 'admin');
    expect(res.success).toBe(true);
    expect(res.officialRecordId).toBe('team-100');
    expect(teamService.createTeamCore).toHaveBeenCalled();
    expect(teamService.afterTeamCommitted).toHaveBeenCalledWith('team-100', 'admin');
  });

  it('should handle CAS failure when draft is already materializing', async () => {
    prisma.adminFormDraft.updateMany.mockResolvedValue({ count: 0 });

    const res = await service.tryMaterialize('draft-1', 'admin');
    expect(res.success).toBe(false);
    expect(res.error).toContain('请勿重复提交');
  });

  it('should call cleanupTempKeys with excludedDraftId when deleting a draft', async () => {
    uploadService.cleanupTempKeys = jest.fn().mockResolvedValue({ cleanedCount: 1 });
    prisma.adminFormDraft.findUnique.mockResolvedValue({
      id: 'draft-1',
      formType: 'TEAM',
      username: 'userA',
      payload: { teamLogo: 'temp/user_xxx/123.webp' },
    });
    prisma.adminFormDraft.delete.mockResolvedValue({});

    await service.deleteDraft('draft-1', 'userA');
    expect(uploadService.cleanupTempKeys).toHaveBeenCalledWith(
      ['temp/user_xxx/123.webp'],
      'userA',
      { excludedDraftId: 'draft-1' },
    );
    expect(prisma.adminFormDraft.delete).toHaveBeenCalledWith({ where: { id: 'draft-1' } });
  });
});
