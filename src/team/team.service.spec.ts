import { ConflictException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { TeamService } from './team.service';

describe('TeamService.createWithPlayers', () => {
  const createService = () => {
    const tx: any = {
      team: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      season: { findMany: jest.fn() },
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

    return {
      service: new TeamService(prisma, auditLogService),
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
    players: [
      {
        name: ' 张三 ',
        studentId: ' 20260001 ',
        jerseyNumber: ' 10 ',
        photo: 'https://images.example/player.webp',
      },
    ],
  };

  it('creates the team, players, active-season roster and audit log in one transaction', async () => {
    const { service, prisma, tx, auditLogService } = createService();
    const savedTeam = { id: 'team-1', teamName: '测试队', players: [{ id: 'player-1' }] };

    tx.team.findFirst.mockResolvedValue(null);
    tx.team.create.mockResolvedValue({ id: 'team-1', teamName: '测试队' });
    tx.season.findMany.mockResolvedValue([{ id: 'season-1' }]);
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
      players: [
        dto.players[0],
        { name: '李四', studentId: '20260002', jerseyNumber: ' 10 ' },
      ],
    };

    await expect(service.createWithPlayers(duplicated, 'admin')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an active duplicate student ID inside the transaction', async () => {
    const { service, tx } = createService();

    tx.team.findFirst.mockResolvedValue(null);
    tx.team.create.mockResolvedValue({ id: 'team-1', teamName: '测试队' });
    tx.season.findMany.mockResolvedValue([]);
    tx.player.findFirst.mockResolvedValue({
      id: 'existing-player',
      studentId: '20260001',
      deletedAt: null,
    });

    await expect(service.createWithPlayers(dto, 'admin')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.team.findUnique).not.toHaveBeenCalled();
  });
});
