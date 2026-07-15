import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlayerDto } from './dto/create-player.dto';
import { UpdatePlayerDto } from './dto/update-player.dto';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class PlayerService {
  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(createPlayerDto: CreatePlayerDto, username: string, userCtx?: any) {
    if (userCtx && userCtx.role === 'coach') {
      if (userCtx.teamId !== createPlayerDto.teamId) {
        throw new ForbiddenException('您没有权限为其他球队创建或导入球员');
      }
    }

    const team = await this.prisma.team.findUnique({
      where: { id: createPlayerDto.teamId },
    });
    if (!team || team.deletedAt !== null) {
      throw new NotFoundException('球队不存在');
    }

    // 检查学号是否已存在
    const existingPlayer = await this.prisma.player.findUnique({
      where: { studentId: createPlayerDto.studentId },
    });

    if (existingPlayer) {
      if (existingPlayer.deletedAt === null) {
        if (userCtx && userCtx.role === 'coach') {
          if (existingPlayer.teamId !== userCtx.teamId) {
            throw new ForbiddenException('该学号的球员已归属于其他球队，您没有权限修改其信息或将其划归至本队');
          }
        }
      }

      // 如果已存在，则更新/恢复球员信息
      const updatedPlayer = await this.prisma.player.update({
        where: { studentId: createPlayerDto.studentId },
        data: {
          name: createPlayerDto.name,
          jerseyNumber: createPlayerDto.jerseyNumber,
          teamId: createPlayerDto.teamId,
          photo: createPlayerDto.photo || existingPlayer.photo || undefined,
          deletedAt: null, // 恢复软删除的球员
        },
        include: { team: true },
      });

      // 自动同步绑定至当前活跃赛季
      const activeSeason = await this.prisma.season.findFirst({ where: { status: 'active' } });
      if (activeSeason) {
        await this.prisma.seasonTeamPlayer.upsert({
          where: {
            seasonId_playerId: {
              seasonId: activeSeason.id,
              playerId: updatedPlayer.id
            }
          },
          create: {
            seasonId: activeSeason.id,
            teamId: updatedPlayer.teamId,
            playerId: updatedPlayer.id
          },
          update: {
            teamId: updatedPlayer.teamId
          }
        });
      }

      await this.auditLogService.log(
        username,
        'UPDATE_PLAYER',
        `导入/关联球员: "${createPlayerDto.name}" (学号: ${createPlayerDto.studentId})`,
      );

      return updatedPlayer;
    }

    const newPlayer = await this.prisma.player.create({
      data: createPlayerDto,
      include: { team: true },
    });

    // 新增球员自动绑定至当前活跃赛季
    const activeSeason = await this.prisma.season.findFirst({ where: { status: 'active' } });
    if (activeSeason) {
      await this.prisma.seasonTeamPlayer.upsert({
        where: {
          seasonId_playerId: {
            seasonId: activeSeason.id,
            playerId: newPlayer.id
          }
        },
        create: {
          seasonId: activeSeason.id,
          teamId: newPlayer.teamId,
          playerId: newPlayer.id
        },
        update: {
          teamId: newPlayer.teamId
        }
      });
    }

    await this.auditLogService.log(
      username,
      'CREATE_PLAYER',
      `新增球员: "${createPlayerDto.name}" (学号: ${createPlayerDto.studentId})`,
    );

    return newPlayer;
  }

  async findAll(teamId?: string, page: number = 1, limit: number = 10) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;
    const where = teamId ? { teamId, deletedAt: null } : { deletedAt: null };

    const [data, total] = await Promise.all([
      this.prisma.player.findMany({
        skip,
        take: limitNum,
        where,
        include: { team: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.player.count({ where }),
    ]);

    return { data, total, page: pageNum, limit: limitNum };
  }

  async findOne(id: string) {
    const player = await this.prisma.player.findUnique({
      where: { id },
      include: { team: true },
    });
    if (!player || player.deletedAt !== null) {
      throw new NotFoundException('球员不存在');
    }
    return player;
  }

  async update(id: string, updatePlayerDto: UpdatePlayerDto, username: string, userCtx?: any) {
    const player = await this.prisma.player.findUnique({ where: { id } });
    if (!player || player.deletedAt !== null) {
      throw new NotFoundException('球员不存在');
    }

    if (userCtx && userCtx.role === 'coach') {
      if (player.teamId !== userCtx.teamId) {
        throw new ForbiddenException('您没有权限修改其他球队的球员信息');
      }
      if (updatePlayerDto.teamId && updatePlayerDto.teamId !== userCtx.teamId) {
        throw new ForbiddenException('您没有权限将球员划归到其他球队');
      }
    }

    if (updatePlayerDto.teamId) {
      const team = await this.prisma.team.findUnique({
        where: { id: updatePlayerDto.teamId },
      });
      if (!team || team.deletedAt !== null) {
        throw new NotFoundException('球队不存在');
      }
    }

    const updatedPlayer = await this.prisma.player.update({
      where: { id },
      data: updatePlayerDto,
      include: { team: true },
    });

    // 如果队籍发生迁移，同步更新当前活跃赛季名册信息
    if (updatePlayerDto.teamId) {
      const activeSeason = await this.prisma.season.findFirst({ where: { status: 'active' } });
      if (activeSeason) {
        await this.prisma.seasonTeamPlayer.upsert({
          where: {
            seasonId_playerId: {
              seasonId: activeSeason.id,
              playerId: id
            }
          },
          create: {
            seasonId: activeSeason.id,
            teamId: updatePlayerDto.teamId,
            playerId: id
          },
          update: {
            teamId: updatePlayerDto.teamId
          }
        });
      }
    }

    const diffs: string[] = [];
    if (updatePlayerDto.name !== undefined && updatePlayerDto.name !== player.name) {
      diffs.push(`姓名: ${player.name}->${updatePlayerDto.name}`);
    }
    if (updatePlayerDto.jerseyNumber !== undefined && updatePlayerDto.jerseyNumber !== player.jerseyNumber) {
      diffs.push(`号码: ${player.jerseyNumber}->${updatePlayerDto.jerseyNumber}`);
    }
    if (updatePlayerDto.studentId !== undefined && updatePlayerDto.studentId !== player.studentId) {
      diffs.push(`学号: ${player.studentId}->${updatePlayerDto.studentId}`);
    }
    if (updatePlayerDto.status !== undefined && updatePlayerDto.status !== player.status) {
      diffs.push(`状态: ${player.status}->${updatePlayerDto.status}`);
    }
    if (updatePlayerDto.teamId !== undefined && updatePlayerDto.teamId !== player.teamId) {
      const oldTeam = await this.prisma.team.findUnique({ where: { id: player.teamId || '' } });
      const newTeam = await this.prisma.team.findUnique({ where: { id: updatePlayerDto.teamId || '' } });
      diffs.push(`球队: ${oldTeam?.teamName || '无'}->${newTeam?.teamName || '无'}`);
    }

    const details = diffs.length > 0
      ? `修改球员 "${player.name}" 信息: ${diffs.join(', ')}`
      : `保存球员 "${player.name}" 信息(未改动)`;

    await this.auditLogService.log(
      username,
      'UPDATE_PLAYER',
      details,
    );

    return updatedPlayer;
  }

  async remove(id: string, username: string, userCtx?: any) {
    const player = await this.prisma.player.findUnique({ where: { id } });
    if (!player || player.deletedAt !== null) {
      throw new NotFoundException('球员不存在');
    }

    if (userCtx && userCtx.role === 'coach') {
      if (player.teamId !== userCtx.teamId) {
        throw new ForbiddenException('您没有权限删除其他球队的球员');
      }
    }

    // 软删除并释放学号唯一约束
    const timestamp = Date.now();
    const result = await this.prisma.player.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        studentId: `${player.studentId}_deleted_${timestamp}`
      }
    });

    await this.auditLogService.log(
      username,
      'DELETE_PLAYER',
      `删除球员: "${player.name}" (学号: ${player.studentId})`,
    );

    return result;
  }

  async searchByName(name: string) {
    if (!name || name.trim() === '') {
      return [];
    }
    return this.prisma.player.findMany({
      where: { name: { contains: name.trim() }, deletedAt: null },
      include: { team: true },
    });
  }

  async getCareerStats(id: string) {
    const player = await this.prisma.player.findUnique({
      where: { id },
      include: { team: true },
    });
    if (!player || player.deletedAt !== null) {
      throw new NotFoundException('球员不存在');
    }

    // 1. 获取所有的进球、红黄牌等事件
    const events = await this.prisma.matchEvent.findMany({
      where: {
        OR: [{ playerId: id }, { assistPlayerId: id }],
        match: {
          status: 'finished',
        },
      },
      include: {
        match: {
          include: {
            season: true,
          },
        },
      },
    });

    // 2. 统计每个赛季的数据
    const seasonStats: Record<
      string,
      {
        seasonId: string;
        seasonName: string;
        goals: number;
        assists: number;
        yellowCards: number;
        redCards: number;
      }
    > = {};

    events.forEach((event) => {
      const season = event.match?.season;
      const seasonId = season?.id || 'unknown';
      const seasonName = season?.name || '未知赛季';

      if (!seasonStats[seasonId]) {
        seasonStats[seasonId] = {
          seasonId,
          seasonName,
          goals: 0,
          assists: 0,
          yellowCards: 0,
          redCards: 0,
        };
      }

      const stats = seasonStats[seasonId];

      if (event.playerId === id) {
        if (event.eventType === 'goal' || event.eventType === 'penalty') {
          stats.goals += 1;
        } else if (event.eventType === 'yellow_card') {
          stats.yellowCards += 1;
        } else if (event.eventType === 'red_card' || event.eventType === 'yellow_to_red') {
          stats.redCards += 1;
        }
      }

      if (event.assistPlayerId === id) {
        if (event.eventType === 'goal' || event.eventType === 'penalty') {
          stats.assists += 1;
        }
      }
    });

    // 3. 计算出场数 (Player appearances)
    const teamMatches = await this.prisma.match.findMany({
      where: {
        status: 'finished',
        OR: [{ homeTeamId: player.teamId }, { awayTeamId: player.teamId }],
      },
      include: {
        season: true,
      },
    });

    const matchCountsBySeason: Record<string, number> = {};
    teamMatches.forEach((m) => {
      const sId = m.season?.id || 'unknown';
      matchCountsBySeason[sId] = (matchCountsBySeason[sId] || 0) + 1;
    });

    // 组装最终结果
    const career = Object.values(seasonStats).map((s) => {
      const teamMatchesCount = matchCountsBySeason[s.seasonId] || 0;
      return {
        ...s,
        appearances: teamMatchesCount,
      };
    });

    return {
      player,
      career,
    };
  }
}
