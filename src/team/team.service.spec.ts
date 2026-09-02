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
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      season: { findUnique: jest.fn() },
      player: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      seasonTeamPlayer: { findFirst: jest.fn(), upsert: jest.fn() },
      seasonTeamProfile: { create: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      team: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      season: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const auditLogService: any = { log: jest.fn() };
    const seasonStatistics: any = { computeAndCache: jest.fn() };
    const assetPipeline: any = {
      prepareTeamAssets: jest.fn(async (d: any, _u: any, _c: any, existingId?: string) => ({
        teamId: existingId || d.id || 'mock-team-id',
        normalizedDto: { ...d },
        promotedAssets: [],
        safeRollback: jest.fn(),
      })),
      safePostCommit: jest.fn(async () => {}),
    };

    return {
      service: new TeamService(
        prisma,
        auditLogService,
        new TeamRosterService(prisma),
        seasonStatistics,
        assetPipeline,
      ),
      prisma,
      tx,
      auditLogService,
      assetPipeline,
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

  it('拒绝教练创建球队', async () => {
    const { service, prisma } = createService();

    await expect(service.createWithPlayers(dto, 'coach', { role: 'coach' })).rejects.toThrow(
      '仅超级管理员可以创建球队',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
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

  it.skip('reuses an existing student for a transfer into the selected season', async () => {
    const { service, tx } = createService();
    const savedTeam = { id: 'team-1', teamName: '测试队', players: [] };

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
      photo: 'old.webp',
    });
    tx.player.update.mockResolvedValue({
      id: 'existing-player',
      name: '张三',
      studentId: '20260001',
      jerseyNumber: '10',
      photo: 'https://images.example/player.webp',
      teamId: 'team-1',
      deletedAt: null,
    });
    tx.seasonTeamPlayer.upsert.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});
    tx.team.findUnique.mockResolvedValue(savedTeam);

    await expect(service.createWithPlayers(dto, 'admin')).resolves.toEqual(savedTeam);
    expect(tx.player.create).not.toHaveBeenCalled();
    expect(tx.player.update).toHaveBeenCalledWith({
      where: { id: 'existing-player' },
      data: expect.objectContaining({
        name: '张三',
        studentId: '20260001',
        jerseyNumber: '10',
        teamId: 'team-1',
        deletedAt: null,
      }),
    });
    expect(tx.seasonTeamPlayer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonId_playerId: {
            seasonId: 'season-1',
            playerId: 'existing-player',
          },
        },
        update: expect.objectContaining({
          teamId: 'team-1',
          playerName: '张三',
          jerseyNumber: '10',
        }),
      }),
    );
  });

  it.skip('reuses a same-name team from another season instead of rejecting it globally', async () => {
    const { service, tx } = createService();
    const historicalTeam = {
      id: 'historical-team',
      teamName: '测试队',
      deletedAt: null,
    };
    const savedTeam = {
      id: 'historical-team',
      teamName: '测试队',
      players: [{ id: 'player-1' }],
    };

    tx.season.findUnique.mockResolvedValue({
      id: 'season-1',
      name: '2026校长杯男子组',
      status: 'active',
    });
    tx.team.findFirst.mockResolvedValueOnce(historicalTeam).mockResolvedValueOnce(null);
    tx.team.update.mockResolvedValue({
      ...historicalTeam,
      homeJerseyColor: '蓝色',
      awayJerseyColor: '白色',
    });
    tx.player.findFirst.mockResolvedValue(null);
    tx.player.create.mockResolvedValue({
      id: 'player-1',
      name: '张三',
      jerseyNumber: '10',
      photo: 'https://images.example/player.webp',
      teamId: historicalTeam.id,
    });
    tx.seasonTeamPlayer.upsert.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});
    tx.team.findUnique.mockResolvedValue(savedTeam);

    await expect(service.createWithPlayers(dto, 'admin')).resolves.toEqual(savedTeam);

    expect(tx.team.create).not.toHaveBeenCalled();
    expect(tx.team.update).toHaveBeenCalledWith({
      where: { id: historicalTeam.id },
      data: expect.objectContaining({
        teamName: '测试队',
        deletedAt: null,
      }),
    });
    expect(tx.seasonTeamPlayer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          seasonId: 'season-1',
          teamId: historicalTeam.id,
        }),
      }),
    );
  });

  it('creates new team and player identities for a different season', async () => {
    const { service, tx } = createService();
    const savedTeam = { id: 'season-team-2', teamName: 'Same Name', players: [] };

    tx.season.findUnique.mockResolvedValue({
      id: 'season-1',
      name: '2026 men',
      status: 'active',
    });
    // The season-scoped lookup does not see a same-name team from another season.
    tx.team.findFirst.mockResolvedValue(null);
    tx.team.create.mockResolvedValue({
      id: 'season-team-2',
      teamName: 'Same Name',
      homeJerseyColor: 'Blue',
      awayJerseyColor: 'White',
    });
    // The same student ID in another season is not a conflict.
    tx.seasonTeamPlayer.findFirst.mockResolvedValue(null);
    tx.player.create.mockResolvedValue({
      id: 'season-player-2',
      name: 'Player',
      jerseyNumber: '10',
      photo: null,
      teamId: 'season-team-2',
    });
    tx.seasonTeamPlayer.upsert.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});
    tx.team.findUnique.mockResolvedValue(savedTeam);

    await expect(service.createWithPlayers(dto, 'admin')).resolves.toEqual(savedTeam);
    expect(tx.team.create).toHaveBeenCalled();
    expect(tx.team.update).not.toHaveBeenCalled();
    expect(tx.player.create).toHaveBeenCalled();
    expect(tx.player.update).not.toHaveBeenCalled();
    expect(tx.seasonTeamPlayer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          seasonId: 'season-1',
          teamId: 'season-team-2',
          playerId: 'season-player-2',
        }),
      }),
    );
  });

  it('rejects a same-name team that is already registered in the selected season', async () => {
    const { service, tx } = createService();
    tx.season.findUnique.mockResolvedValue({
      id: 'season-1',
      name: '2026校长杯男子组',
      status: 'active',
    });
    tx.team.findFirst
      .mockResolvedValueOnce({ id: 'team-1', teamName: '测试队', deletedAt: null })
      .mockResolvedValueOnce({ id: 'team-1' });

    await expect(service.createWithPlayers(dto, 'admin')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.team.create).not.toHaveBeenCalled();
    expect(tx.team.update).not.toHaveBeenCalled();
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
      seasonTeamPlayer: { findFirst: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
      seasonTeamProfile: { upsert: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const prisma: any = {
      team: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
      season: { findUnique: jest.fn(), findMany: jest.fn() },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const assetPipeline: any = {
      prepareTeamAssets: jest.fn(async (d: any, _u: any, _c: any, existingId?: string) => ({
        teamId: existingId || d.id || 'mock-team-id',
        normalizedDto: { ...d },
        promotedAssets: [],
        safeRollback: jest.fn(),
      })),
      safePostCommit: jest.fn(async () => {}),
    };
    const service = new TeamService(
      prisma,
      { log: jest.fn() } as any,
      new TeamRosterService(prisma),
      { computeAndCache: jest.fn() } as any,
      assetPipeline,
    );
    return { service, prisma, tx, assetPipeline };
  };

  it('updates only the selected season snapshot when player details change', async () => {
    const { service, prisma, tx } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', teamName: 'Team', deletedAt: null });
    prisma.season.findUnique.mockResolvedValue({ id: 'season-1', name: '2026 男子组' });
    tx.seasonTeamProfile.upsert.mockResolvedValue({
      id: 'profile-1',
      seasonId: 'season-1',
      teamId: 'team-1',
      teamName: 'Team',
      teamDoctor: 'Doctor',
      headCoach: 'Coach',
      teamLeader: 'Leader',
      coachPhone: '100',
      leaderPhone: '200',
      homeJerseyColor: 'Red',
      awayJerseyColor: 'White',
      teamLogo: null,
      homeJersey: null,
      awayJersey: null,
      gender: 'MALE',
    });
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
        seasonId: 'season-1',
        players: [{ id: 'player-1', name: 'Player', studentId: 'new-id', jerseyNumber: '10' }],
      },
      'coach',
      { role: 'coach', teamId: 'team-1' },
    );

    expect(tx.player.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'player-1' },
        data: expect.not.objectContaining({ studentId: 'new-id' }),
      }),
    );
    expect(tx.seasonTeamPlayer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { seasonId_playerId: { seasonId: 'season-1', playerId: 'player-1' } },
        update: expect.objectContaining({ studentId: 'new-id' }),
      }),
    );
    expect(tx.player.create).not.toHaveBeenCalled();
    expect(tx.seasonTeamProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { seasonId_teamId: { seasonId: 'season-1', teamId: 'team-1' } },
      }),
    );
  });

  it('allows updating team with existing player from another team/season and updating season jersey number', async () => {
    const { service, prisma, tx } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', teamName: 'Team A', deletedAt: null });
    prisma.season.findUnique.mockResolvedValue({ id: 'season-1', name: '2026 男子组' });
    tx.seasonTeamProfile.upsert.mockResolvedValue({
      id: 'profile-1',
      seasonId: 'season-1',
      teamId: 'team-1',
      teamName: 'Team A',
      gender: 'MALE',
    });
    tx.player.findUnique.mockResolvedValue({
      id: 'player-2',
      teamId: 'team-other', // Historical team was team-other
      studentId: '20230099',
      photo: null,
      yellowCards: 0,
      redCards: 0,
      deletedAt: null,
    });
    tx.seasonTeamPlayer.findFirst.mockResolvedValue(null);
    tx.player.update.mockResolvedValue({ id: 'player-2' });
    tx.auditLog.create.mockResolvedValue({});
    tx.team.findUnique.mockResolvedValue({ id: 'team-1', players: [{ id: 'player-2' }] });

    await service.updateWithPlayers(
      'team-1',
      {
        seasonId: 'season-1',
        players: [{ id: 'player-2', name: '刘哲玮', studentId: '20230099', jerseyNumber: '99' }],
      },
      'admin',
      { role: 'super_admin' },
    );

    expect(tx.seasonTeamPlayer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { seasonId_playerId: { seasonId: 'season-1', playerId: 'player-2' } },
        create: expect.objectContaining({
          teamId: 'team-1',
          jerseyNumber: '99',
        }),
      }),
    );
  });

  it('preserves existing Player.photo and SeasonTeamPlayer snapshot when photo is omitted (undefined)', async () => {
    const { service, prisma, tx, assetPipeline } = createService();
    prisma.team.findUnique.mockResolvedValue({
      id: 'team-1',
      teamName: 'Team A',
      gender: 'MALE',
      deletedAt: null,
    });
    prisma.season.findUnique.mockResolvedValue({
      id: 'season-1',
      name: '2024 Season',
      status: 'active',
    });
    tx.team.findUnique.mockResolvedValue({
      id: 'team-1',
      teamName: 'Team A',
      gender: 'MALE',
      deletedAt: null,
      players: [{ id: 'player-1' }],
    });
    tx.seasonTeamProfile.upsert.mockResolvedValue({
      id: 'profile-1',
      seasonId: 'season-1',
      teamId: 'team-1',
      teamName: 'Team A',
    });
    tx.player.findUnique.mockResolvedValue({
      id: 'player-1',
      teamId: 'team-1',
      name: '原名',
      studentId: '20230001',
      jerseyNumber: '10',
      photo: 'https://assets.sztufa.xyz/uploads/players/player-1/photo/original.webp',
      deletedAt: null,
    });
    tx.seasonTeamPlayer.findFirst.mockResolvedValue({
      id: 'stp-1',
      playerPhoto: 'https://assets.sztufa.xyz/uploads/players/player-1/photo/original.webp',
    });
    tx.player.update.mockResolvedValue({ id: 'player-1' });
    tx.seasonTeamPlayer.upsert.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});
    tx.team.update.mockResolvedValue({});

    assetPipeline.prepareTeamAssets.mockResolvedValue({
      teamId: 'team-1',
      normalizedDto: {
        seasonId: 'season-1',
        players: [{ id: 'player-1', name: '新名', studentId: '20230001', jerseyNumber: '10' }], // photo omitted (undefined)
      },
      promotedAssets: [],
      safeRollback: jest.fn(),
    });

    await service.updateWithPlayers(
      'team-1',
      {
        seasonId: 'season-1',
        players: [{ id: 'player-1', name: '新名' } as any],
      },
      'admin',
      { role: 'super_admin' },
    );

    // 验证 Player.update 保留了现有 photo
    expect(tx.player.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'player-1' },
        data: expect.objectContaining({
          photo: 'https://assets.sztufa.xyz/uploads/players/player-1/photo/original.webp',
        }),
      }),
    );

    // 验证 SeasonTeamPlayer.upsert 的 update 分支未将 playerPhoto 覆盖为 null
    const upsertCall = tx.seasonTeamPlayer.upsert.mock.calls[0][0];
    expect(upsertCall.update.playerPhoto).toBeUndefined();
  });

  it('explicitly clears Player.photo and SeasonTeamPlayer snapshot when photo is null', async () => {
    const { service, prisma, tx, assetPipeline } = createService();
    prisma.team.findUnique.mockResolvedValue({
      id: 'team-1',
      teamName: 'Team A',
      gender: 'MALE',
      deletedAt: null,
    });
    prisma.season.findUnique.mockResolvedValue({
      id: 'season-1',
      name: '2024 Season',
      status: 'active',
    });
    tx.team.findUnique.mockResolvedValue({
      id: 'team-1',
      teamName: 'Team A',
      gender: 'MALE',
      deletedAt: null,
      players: [{ id: 'player-1' }],
    });
    tx.seasonTeamProfile.upsert.mockResolvedValue({
      id: 'profile-1',
      seasonId: 'season-1',
      teamId: 'team-1',
      teamName: 'Team A',
    });
    tx.player.findUnique.mockResolvedValue({
      id: 'player-1',
      teamId: 'team-1',
      name: '原名',
      studentId: '20230001',
      jerseyNumber: '10',
      photo: 'https://assets.sztufa.xyz/uploads/players/player-1/photo/original.webp',
      deletedAt: null,
    });
    tx.player.update.mockResolvedValue({ id: 'player-1' });
    tx.seasonTeamPlayer.upsert.mockResolvedValue({});
    tx.auditLog.create.mockResolvedValue({});
    tx.team.update.mockResolvedValue({});

    assetPipeline.prepareTeamAssets.mockResolvedValue({
      teamId: 'team-1',
      normalizedDto: {
        seasonId: 'season-1',
        players: [
          { id: 'player-1', name: '原名', studentId: '20230001', jerseyNumber: '10', photo: null },
        ], // photo explicitly null
      },
      promotedAssets: [],
      safeRollback: jest.fn(),
    });

    await service.updateWithPlayers(
      'team-1',
      {
        seasonId: 'season-1',
        players: [{ id: 'player-1', name: '原名', photo: null } as any],
      },
      'admin',
      { role: 'super_admin' },
    );

    // 验证 Player.update 清空 photo
    expect(tx.player.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'player-1' },
        data: expect.objectContaining({
          photo: null,
        }),
      }),
    );

    // 验证 SeasonTeamPlayer.upsert 的 update 分支显式将 playerPhoto 设置为 null
    const upsertCall = tx.seasonTeamPlayer.upsert.mock.calls[0][0];
    expect(upsertCall.update.playerPhoto).toBeNull();
  });

  it('rejects a coach attempting to update another team', async () => {
    const { service, prisma } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-2', teamName: 'Other', deletedAt: null });

    await expect(
      service.updateWithPlayers('team-2', { seasonId: 'season-1', players: [] }, 'coach', {
        role: 'coach',
        teamId: 'team-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('create() strips pipeline-internal fields and does not pass preallocatedTeamId or players array to prisma.team.create', async () => {
    const { service, prisma, assetPipeline } = createService();
    prisma.team.findFirst.mockResolvedValue(null);
    prisma.team.create.mockResolvedValue({ id: 'team-1', teamName: '测试队' });

    assetPipeline.prepareTeamAssets.mockResolvedValue({
      teamId: 'preallocated-123',
      normalizedDto: {
        teamName: '测试队',
        preallocatedTeamId: 'preallocated-123',
        players: [{ name: '新球员' }],
        seasonId: 'season-1',
      },
      promotedAssets: [],
      safeRollback: jest.fn(),
    });

    await service.create({ teamName: '测试队' } as any, 'admin', { role: 'super_admin' });

    expect(prisma.team.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'preallocated-123',
        teamName: '测试队',
      }),
      include: { players: { where: { deletedAt: null } } },
    });

    const createCallData = prisma.team.create.mock.calls[0][0].data;
    expect(createCallData.preallocatedTeamId).toBeUndefined();
    expect(createCallData.players).toBeUndefined();
    expect(createCallData.seasonId).toBeUndefined();
  });

  it('update() strips pipeline-internal fields before calling prisma.team.update', async () => {
    const { service, prisma, assetPipeline } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', teamName: '原名', deletedAt: null });
    prisma.team.update.mockResolvedValue({ id: 'team-1', teamName: '新名' });
    prisma.season.findMany.mockResolvedValue([]);

    assetPipeline.prepareTeamAssets.mockResolvedValue({
      teamId: 'team-1',
      normalizedDto: {
        teamName: '新名',
        preallocatedTeamId: 'team-1',
        players: [],
        deletePlayerIds: ['p-1'],
        seasonId: 'season-1',
      },
      promotedAssets: [],
      safeRollback: jest.fn(),
    });

    await service.update('team-1', { teamName: '新名' } as any, 'admin');

    expect(prisma.team.update).toHaveBeenCalledWith({
      where: { id: 'team-1' },
      data: expect.objectContaining({
        teamName: '新名',
      }),
      include: { players: { where: { deletedAt: null } } },
    });

    const updateCallData = prisma.team.update.mock.calls[0][0].data;
    expect(updateCallData.preallocatedTeamId).toBeUndefined();
    expect(updateCallData.players).toBeUndefined();
    expect(updateCallData.deletePlayerIds).toBeUndefined();
    expect(updateCallData.seasonId).toBeUndefined();
  });
});
