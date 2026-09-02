import { Test, TestingModule } from '@nestjs/testing';
import { PlayerService } from './player.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BadRequestException } from '@nestjs/common';

describe('PlayerService', () => {
  let service: PlayerService;
  let prisma: any;
  let auditLogService: any;

  beforeEach(async () => {
    prisma = {
      team: { findUnique: jest.fn() },
      season: { findFirst: jest.fn(), findUnique: jest.fn() },
      seasonTeamProfile: { findUnique: jest.fn() },
      player: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      seasonTeamPlayer: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
      matchEvent: { findMany: jest.fn() },
      matchLineup: { findMany: jest.fn() },
      $transaction: jest.fn(async (cb) => cb(prisma)),
    };

    auditLogService = {
      log: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlayerService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    service = module.get<PlayerService>(PlayerService);
  });

  it('should reject player creation when team has no SeasonTeamProfile even for super_admin', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', deletedAt: null, gender: 'MALE' });
    prisma.season.findFirst.mockResolvedValue({ id: 'season-1', name: '2026 男子组' });
    prisma.seasonTeamProfile.findUnique.mockResolvedValue(null);

    await expect(
      service.create(
        { teamId: 'team-1', name: '张三', studentId: '2026001', jerseyNumber: '10' },
        'admin',
        { role: 'super_admin' },
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.player.create).not.toHaveBeenCalled();
  });

  it('should create player and sync to season within the transaction when profile exists', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', deletedAt: null, gender: 'MALE' });
    prisma.season.findFirst.mockResolvedValue({ id: 'season-1', name: '2026 男子组' });
    prisma.season.findUnique.mockResolvedValue({ id: 'season-1', name: '2026 男子组' });
    prisma.seasonTeamProfile.findUnique.mockResolvedValue({ id: 'profile-1' });
    prisma.player.create.mockResolvedValue({
      id: 'player-1',
      teamId: 'team-1',
      name: '张三',
      studentId: '2026001',
      jerseyNumber: '10',
    });

    const res = await service.create(
      { teamId: 'team-1', name: '张三', studentId: '2026001', jerseyNumber: '10' },
      'admin',
      { role: 'super_admin' },
    );

    expect(res.id).toBe('player-1');
    expect(prisma.player.create).toHaveBeenCalled();
    expect(prisma.seasonTeamPlayer.upsert).toHaveBeenCalled();
  });

  it('limits a player card to the selected season', async () => {
    const playerId = 'player-1';
    const seasonId = 'season-2026';
    prisma.player.findUnique.mockResolvedValue({
      id: playerId,
      name: '测试女球员',
      deletedAt: null,
      team: { id: 'team-2026', teamName: '女子队' },
    });
    prisma.seasonTeamPlayer.findMany.mockResolvedValue([
      { playerId, season: { id: seasonId, name: '2026校长杯女子组' } },
    ]);
    prisma.matchEvent.findMany.mockResolvedValue([
      {
        id: 'event-1',
        playerId,
        assistPlayerId: null,
        eventType: 'goal',
        match: { season: { id: 'season-2026', name: '2026校长杯女子组' } },
      },
      {
        id: 'event-1',
        playerId,
        assistPlayerId: null,
        eventType: 'goal',
        match: { season: { id: 'season-2026', name: '2026校长杯女子组' } },
      },
    ]);
    prisma.matchLineup.findMany.mockResolvedValue([
      {
        matchId: 'match-1',
        playerId,
        match: {
          id: 'match-1',
          season: { id: 'season-2026', name: '2026校长杯女子组' },
        },
      },
      {
        matchId: 'match-1',
        playerId,
        match: {
          id: 'match-1',
          season: { id: 'season-2026', name: '2026校长杯女子组' },
        },
      },
    ]);

    const result = await service.getCareerStats(playerId, seasonId);

    expect(prisma.seasonTeamPlayer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerId, seasonId },
      }),
    );
    expect(prisma.matchEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ match: { status: 'finished', seasonId } }),
      }),
    );
    expect(result.career).toEqual([
      expect.objectContaining({
        seasonName: '2026校长杯女子组',
        appearances: 1,
        goals: 1,
      }),
    ]);
  });

  it('rejects a player card request without a season', async () => {
    await expect(service.getCareerStats('player-1', '')).rejects.toThrow(BadRequestException);
    expect(prisma.player.findUnique).not.toHaveBeenCalled();
  });
});
