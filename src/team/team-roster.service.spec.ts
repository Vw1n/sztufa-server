import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { TeamRosterService } from './team-roster.service';

describe('TeamRosterService', () => {
  const createService = () => {
    const prisma: any = {
      team: { findUnique: jest.fn() },
      season: { findFirst: jest.fn() },
      seasonTeamPlayer: { findMany: jest.fn() },
    };
    return { service: new TeamRosterService(prisma), prisma };
  };

  it('validates an active season matching the team gender', async () => {
    const { service } = createService();
    const tx: any = {
      season: {
        findUnique: (jest.fn() as any).mockResolvedValue({
          id: 'season-1',
          name: '2026校长杯男子组',
          status: 'active',
        }),
      },
    };

    await expect(service.validateTargetSeason(tx, 'season-1', 'MALE')).resolves.toEqual({
      id: 'season-1',
      name: '2026校长杯男子组',
      status: 'active',
    });
  });

  it('rejects inactive and gender-mismatched seasons with the existing messages', async () => {
    const { service } = createService();
    const tx: any = { season: { findUnique: jest.fn() } };

    tx.season.findUnique.mockResolvedValue(null);
    await expect(service.validateTargetSeason(tx, 'missing', 'MALE')).rejects.toThrow(
      '所选赛季不存在或已不是活跃赛季',
    );

    tx.season.findUnique.mockResolvedValue({
      id: 'season-1',
      name: '2026校长杯女子组',
      status: 'active',
    });
    await expect(service.validateTargetSeason(tx, 'season-1', 'MALE')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('registers a player with a season-specific profile snapshot', async () => {
    const { service } = createService();
    const tx: any = {
      seasonTeamPlayer: { upsert: (jest.fn() as any).mockResolvedValue({}) },
    };

    await service.registerPlayer(tx, 'season-1', 'team-1', {
      id: 'player-1',
      studentId: '20260001',
      name: '张三',
      jerseyNumber: '9',
      photo: 'player.webp',
    });

    expect(tx.seasonTeamPlayer.upsert).toHaveBeenCalledWith({
      where: { seasonId_playerId: { seasonId: 'season-1', playerId: 'player-1' } },
      create: {
        seasonId: 'season-1',
        teamId: 'team-1',
        playerId: 'player-1',
        studentId: '20260001',
        playerName: '张三',
        jerseyNumber: '9',
        playerPhoto: 'player.webp',
      },
      update: {
        teamId: 'team-1',
        studentId: '20260001',
        playerName: '张三',
        jerseyNumber: '9',
        playerPhoto: 'player.webp',
      },
    });
  });

  it('returns the selected-season roster sorted by jersey number', async () => {
    const { service, prisma } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', deletedAt: null });
    prisma.seasonTeamPlayer.findMany.mockResolvedValue([
      {
        teamId: 'team-1',
        playerName: '旧姓名20',
        jerseyNumber: '20',
        playerPhoto: 'old-20.webp',
        player: { id: 'player-20', name: '新姓名20', jerseyNumber: '8', photo: 'new.webp' },
      },
      {
        teamId: 'team-1',
        playerName: '旧姓名2',
        jerseyNumber: '2',
        playerPhoto: null,
        player: { id: 'player-2', name: '新姓名2', jerseyNumber: '10', photo: 'new.webp' },
      },
    ]);

    await expect(service.getTeamRoster('team-1', 'season-1')).resolves.toEqual([
      {
        id: 'player-2',
        name: '旧姓名2',
        jerseyNumber: '2',
        photo: null,
        teamId: 'team-1',
      },
      {
        id: 'player-20',
        name: '旧姓名20',
        jerseyNumber: '20',
        photo: 'old-20.webp',
        teamId: 'team-1',
      },
    ]);
    const rosterQuery = (prisma.seasonTeamPlayer.findMany.mock.calls as any[][])[0][0];
    expect(rosterQuery.select.studentId).toBeUndefined();
    expect(rosterQuery.select.player.select.studentId).toBeUndefined();
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
  });

  it('does not fall back to players from other seasons when a roster is empty', async () => {
    const { service, prisma } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', deletedAt: null });
    prisma.seasonTeamPlayer.findMany.mockResolvedValue([]);

    await expect(service.getTeamRoster('team-1', 'season-1')).resolves.toEqual([]);
  });

  it('keeps the no-active-season error when no season is supplied', async () => {
    const { service, prisma } = createService();
    prisma.team.findUnique.mockResolvedValue({ id: 'team-1', deletedAt: null });
    prisma.season.findFirst.mockResolvedValue(null);

    await expect(service.getTeamRoster('team-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
