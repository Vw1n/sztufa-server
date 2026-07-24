import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { TeamService } from './team.service';
import { TeamRosterService } from './team-roster.service';

describe('TeamService.createWithPlayers', () => {
  const createService = () => {
    const tx: any = {
      team: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      season: { findUnique: jest.fn() },
      player: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      seasonTeamPlayer: { upsert: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const auditLogService: any = { log: jest.fn() };
    const seasonStatistics: any = { computeAndCache: jest.fn() };

    return {
      service: new TeamService(
        prisma,
        auditLogService,
        new TeamRosterService(prisma),
        seasonStatistics,
      ),
      prisma,
      tx,
      auditLogService,
    };
  };

  const dto = {
    teamName: '测试队',
    homeJerseyColor: '蓝色',
    awayJerseyColor: '白色',
    teamLogo: 'https://images.example/team.webp',
    seasonId: 'season-1',
    players: [
      {
        name: ' 张三 ',
        studentId: ' 20260001 ',
        jerseyNumber: ' 10 ',
        photo: 'https://images.example/player.webp',
      },
    ],
  };

  it('creates the team, players, selected-season roster and audit log in one transaction', async () => {
    const { service, prisma, tx, auditLogService } = createService();
    const savedTeam = { id: 'team-1', teamName: '测试队', players: [{ id: 'player-1' }] };

    tx.team.findFirst.mockResolvedValue(null);
    tx.season.findUnique.mockResolvedValue({
      id: 'season-1',
      name: '2026校长杯男子组',
      status: 'active',
    });
    tx.team.create.mockResolvedValue({ id: 'team-1', teamName: '测试队' });
    tx.player.findFirst.mockResolvedValue(null);
    tx.player.create.mockResolvedValue({ id: 'player-1', teamId: 'team-1' });
    tx.seasonTeamPlayer.upsert.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});
    tx.team.findUnique.mockResolvedValue(savedTeam);

    await expect(service.createWithPlayers(dto, 'admin')).resolves.toEqual(savedTeam);

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30000 });
    expect(tx.player.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: '张三',
        studentId: '20260001',
        jerseyNumber: '10',
        teamId: 'team-1',
        photo: 'https://images.example/player.webp',
      }),
    });
    expect(tx.seasonTeamPlayer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          seasonId: 'season-1',
          teamId: 'team-1',
          playerId: 'player-1',
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(auditLogService.log).not.toHaveBeenCalled();
  });

  it('rejects duplicate jersey numbers before starting the transaction', async () => {
    const { service, prisma } = createService();
    const duplicated = {
      ...dto,
      players: [dto.players[0], { name: '李四', studentId: '20260002', jerseyNumber: ' 10 ' }],
    };

    await expect(service.createWithPlayers(duplicated, 'admin')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an active duplicate student ID inside the transaction', async () => {
    const { service, tx } = createService();

    tx.team.findFirst.mockResolvedValue(null);
    tx.season.findUnique.mockResolvedValue({
      id: 'season-1',
      name: '2026校长杯男子组',
      status: 'active',
    });
    tx.team.create.mockResolvedValue({ id: 'team-1', teamName: '测试队' });
    tx.player.findFirst.mockResolvedValue({
      id: 'existing-player',
      studentId: '20260001',
      deletedAt: null,
    });

    await expect(service.createWithPlayers(dto, 'admin')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.team.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an empty player list before starting the transaction', async () => {
    const { service, prisma } = createService();

    await expect(
      service.createWithPlayers({ ...dto, players: [] }, 'admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a team whose gender does not match the selected season', async () => {
    const { service, tx } = createService();
    tx.season.findUnique.mockResolvedValue({
      id: 'season-1',
      name: '2026校长杯女子组',
      status: 'active',
    });

    await expect(service.createWithPlayers(dto, 'admin')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.team.create).not.toHaveBeenCalled();
  });
});

describe('TeamService.updateWithPlayers', () => {
  const createService = () => {
    const tx: any = {
      team: { update: jest.fn(), findUnique: jest.fn() },
      player: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
      seasonTeamPlayer: { upsert: jest.fn(), deleteMany: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      team: { findUnique: jest.fn(), findFirst: jest.fn() },
      season: { findMany: jest.fn() },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new TeamService(
      prisma,
      { log: jest.fn() } as any,
      new TeamRosterService(prisma),
      { computeAndCache: jest.fn() } as any,
    );
    return { service, prisma, tx };
  };

  it('updates an existing player by ID when the student ID changes', async () => {
    const { service, prisma, tx } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', teamName: 'Team', deletedAt: null });
    prisma.season.findMany.mockResolvedValue([]);
    tx.team.update.mockResolvedValue({ id: 'team-1' });
    tx.player.findUnique.mockResolvedValue({
      id: 'player-1',
      teamId: 'team-1',
      studentId: 'old-id',
      photo: null,
      yellowCards: 0,
      redCards: 0,
      deletedAt: null,
    });
    tx.player.findFirst.mockResolvedValue(null);
    tx.player.update.mockResolvedValue({ id: 'player-1' });
    tx.auditLog.create.mockResolvedValue({});
    tx.team.findUnique.mockResolvedValue({ id: 'team-1', players: [{ id: 'player-1' }] });

    await service.updateWithPlayers(
      'team-1',
      {
        players: [{ id: 'player-1', name: 'Player', studentId: 'new-id', jerseyNumber: '10' }],
      },
      'coach',
      { role: 'coach', teamId: 'team-1' },
    );

    expect(tx.player.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'player-1' },
        data: expect.objectContaining({ studentId: 'new-id' }),
      }),
    );
    expect(tx.player.create).not.toHaveBeenCalled();
  });

  it('rejects a coach attempting to update another team', async () => {
    const { service, prisma } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-2', teamName: 'Other', deletedAt: null });

    await expect(
      service.updateWithPlayers('team-2', { players: [] }, 'coach', {
        role: 'coach',
        teamId: 'team-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
