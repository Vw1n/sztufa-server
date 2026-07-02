import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMatchDto } from './dto/create-match.dto';
import { UpdateMatchDto } from './dto/update-match.dto';

@Injectable()
export class MatchService {
  constructor(private prisma: PrismaService) {}

  async create(createMatchDto: CreateMatchDto) {
    const [homeTeam, awayTeam] = await Promise.all([
      this.prisma.team.findUnique({ where: { id: createMatchDto.homeTeamId } }),
      this.prisma.team.findUnique({ where: { id: createMatchDto.awayTeamId } }),
    ]);

    if (!homeTeam) {
      throw new NotFoundException('主队不存在');
    }
    if (!awayTeam) {
      throw new NotFoundException('客队不存在');
    }

    const { goals, events, ...matchData } = createMatchDto;
    const match = await this.prisma.match.create({
      data: matchData,
      include: { homeTeam: true, awayTeam: true },
    });

    if (events && events.length > 0) {
      await this.prisma.matchEvent.createMany({
        data: events.map((e) => ({
          matchId: match.id,
          eventTime: e.eventTime,
          eventType: e.eventType,
          description: e.description,
          teamType: e.teamType,
          playerId: e.playerId || null,
          playerName: e.playerName || null,
          jerseyNumber: e.jerseyNumber || null,
          subPlayerId: e.subPlayerId || null,
          subPlayerName: e.subPlayerName || null,
          subJerseyNumber: e.subJerseyNumber || null,
        })),
      });
    }

    // 自动同步进球记录到 Goal 表以向下兼容展示端
    const goalEvents = events ? events.filter(e => e.eventType === 'goal' || e.eventType === 'penalty' || e.eventType === 'own_goal') : [];
    if (goalEvents.length > 0) {
      await this.prisma.goal.createMany({
        data: goalEvents.map((g) => ({
          matchId: match.id,
          playerName: g.eventType === 'own_goal' ? `${g.playerName} (乌龙)` : g.eventType === 'penalty' ? `${g.playerName} (点球)` : g.playerName || '',
          jerseyNumber: g.jerseyNumber || '',
          goalTime: g.eventTime,
          teamType: g.eventType === 'own_goal' ? (g.teamType === 'home' ? 'away' : 'home') : g.teamType,
          playerId: g.playerId || null,
        })),
      });
    } else if (goals && goals.length > 0) {
      await this.prisma.goal.createMany({
        data: goals.map((g) => ({
          matchId: match.id,
          playerName: g.playerName,
          jerseyNumber: g.jerseyNumber,
          goalTime: g.goalTime,
          teamType: g.teamType,
          playerId: g.playerId || null,
        })),
      });
    }

    return this.prisma.match.findUnique({
      where: { id: match.id },
      include: { homeTeam: true, awayTeam: true, goals: true, events: true },
    });
  }

  async findAll(page: number = 1, limit: number = 10, teamId?: string) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;
    const where = teamId
      ? {
          OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
        }
      : {};

    const [data, total] = await Promise.all([
      this.prisma.match.findMany({
        skip,
        take: limitNum,
        where,
        include: { homeTeam: true, awayTeam: true, goals: true, events: true },
        orderBy: { matchDate: 'desc' },
      }),
      this.prisma.match.count({ where }),
    ]);

    return { data, total, page: pageNum, limit: limitNum };
  }

  async findOne(id: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: { homeTeam: true, awayTeam: true, goals: true, events: true },
    });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }
    return match;
  }

  async update(id: string, updateMatchDto: UpdateMatchDto) {
    const match = await this.prisma.match.findUnique({ where: { id } });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }

    if (updateMatchDto.homeTeamId) {
      const homeTeam = await this.prisma.team.findUnique({
        where: { id: updateMatchDto.homeTeamId },
      });
      if (!homeTeam) {
        throw new NotFoundException('主队不存在');
      }
    }

    if (updateMatchDto.awayTeamId) {
      const awayTeam = await this.prisma.team.findUnique({
        where: { id: updateMatchDto.awayTeamId },
      });
      if (!awayTeam) {
        throw new NotFoundException('客队不存在');
      }
    }

    const { goals, events, ...matchData } = updateMatchDto;

    await this.prisma.match.update({
      where: { id },
      data: matchData,
    });

    // 同步比赛事件数据
    await this.prisma.matchEvent.deleteMany({ where: { matchId: id } });
    if (events && events.length > 0) {
      await this.prisma.matchEvent.createMany({
        data: events.map((e) => ({
          matchId: id,
          eventTime: e.eventTime,
          eventType: e.eventType,
          description: e.description,
          teamType: e.teamType,
          playerId: e.playerId || null,
          playerName: e.playerName || null,
          jerseyNumber: e.jerseyNumber || null,
          subPlayerId: e.subPlayerId || null,
          subPlayerName: e.subPlayerName || null,
          subJerseyNumber: e.subJerseyNumber || null,
        })),
      });
    }

    // 同步进球数据到 Goal 表（向下兼容展示端）
    await this.prisma.goal.deleteMany({ where: { matchId: id } });
    const goalEvents = events ? events.filter(e => e.eventType === 'goal' || e.eventType === 'penalty' || e.eventType === 'own_goal') : [];
    if (goalEvents.length > 0) {
      await this.prisma.goal.createMany({
        data: goalEvents.map((g) => ({
          matchId: id,
          playerName: g.eventType === 'own_goal' ? `${g.playerName} (乌龙)` : g.eventType === 'penalty' ? `${g.playerName} (点球)` : g.playerName || '',
          jerseyNumber: g.jerseyNumber || '',
          goalTime: g.eventTime,
          teamType: g.eventType === 'own_goal' ? (g.teamType === 'home' ? 'away' : 'home') : g.teamType,
          playerId: g.playerId || null,
        })),
      });
    } else if (goals && goals.length > 0) {
      await this.prisma.goal.createMany({
        data: goals.map((g) => ({
          matchId: id,
          playerName: g.playerName,
          jerseyNumber: g.jerseyNumber,
          goalTime: g.goalTime,
          teamType: g.teamType,
          playerId: g.playerId || null,
        })),
      });
    }

    return this.prisma.match.findUnique({
      where: { id },
      include: { homeTeam: true, awayTeam: true, goals: true, events: true },
    });
  }

  async remove(id: string) {
    const match = await this.prisma.match.findUnique({ where: { id } });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }
    return this.prisma.match.delete({ where: { id } });
  }
}
