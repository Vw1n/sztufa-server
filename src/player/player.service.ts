import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlayerDto } from './dto/create-player.dto';
import { UpdatePlayerDto } from './dto/update-player.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { isTeamGenderCompatibleWithSeason } from '../common/season-gender';

@Injectable()
export class PlayerService {
  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * 将球员同步到指定的单一目标赛季名册中
   */
  /**
   * 将球员同步到指定的单一目标赛季名册中
   */
  private async syncPlayerToSeason(
    tx: any,
    player: {
      id: string;
      teamId: string;
      name: string;
      studentId: string;
      jerseyNumber: string;
      photo?: string | null;
    },
    seasonId: string,
  ): Promise<void> {
    const { id: playerId, teamId } = player;
    const runner = tx || this.prisma;
    const [season, team] = await Promise.all([
      runner.season.findUnique({ where: { id: seasonId } }),
      runner.team.findUnique({ where: { id: teamId }, select: { gender: true } }),
    ]);

    if (!season || !team) {
      throw new BadRequestException('目标赛季或球队不存在');
    }

    if (!isTeamGenderCompatibleWithSeason(season.name, team.gender)) {
      await runner.seasonTeamPlayer.deleteMany({
        where: { seasonId: season.id, playerId },
      });
      return;
    }

    await runner.seasonTeamPlayer.upsert({
      where: {
        seasonId_playerId: {
          seasonId: season.id,
          playerId,
        },
      },
      create: {
        seasonId: season.id,
        teamId,
        playerId,
        playerName: player.name,
        studentId: player.studentId,
        jerseyNumber: player.jerseyNumber,
        playerPhoto: player.photo,
      },
      update: {
        teamId,
        playerName: player.name,
        studentId: player.studentId,
        jerseyNumber: player.jerseyNumber,
        playerPhoto: player.photo,
      },
    });
  }

  async create(createPlayerDto: CreatePlayerDto, username: string, userCtx?: any) {
    return this.prisma.$transaction(async (tx) => {
      if (userCtx && userCtx.role === 'coach') {
        if (userCtx.teamId !== createPlayerDto.teamId) {
          throw new ForbiddenException('您没有权限为其他球队创建或导入球员');
        }
      }

      const isSuperAdmin = userCtx?.role === 'super_admin';

      const team = await tx.team.findUnique({
        where: { id: createPlayerDto.teamId },
      });
      if (!team || team.deletedAt !== null) {
        throw new NotFoundException('球队不存在');
      }

      let targetSeasonId = createPlayerDto.seasonId;
      if (!targetSeasonId) {
        const activeSeason = await tx.season.findFirst({
          where: { status: 'active' },
          orderBy: { createdAt: 'desc' },
        });
        targetSeasonId = activeSeason?.id;
      }

      if (!targetSeasonId) {
        throw new BadRequestException('无法确定目标赛季，无法创建球员');
      }

      const profile = await tx.seasonTeamProfile.findUnique({
        where: { seasonId_teamId: { seasonId: targetSeasonId, teamId: createPlayerDto.teamId } },
      });
      if (!profile) {
        throw new BadRequestException('球队在所选赛季中尚未注册');
      }

      if (!isSuperAdmin) {
        const existingPlayer = await tx.player.findFirst({
          where: {
            OR: [
              { studentId: createPlayerDto.studentId },
              { studentId: { startsWith: `${createPlayerDto.studentId}_deleted_` } },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existingPlayer) {
          if (existingPlayer.deletedAt === null) {
            if (userCtx && userCtx.role === 'coach') {
              if (existingPlayer.teamId !== userCtx.teamId) {
                throw new ForbiddenException(
                  '该学号的球员已归属于其他球队，您没有权限修改其信息或将其划归至本队',
                );
              }
            }
          }

          const updatedPlayer = await tx.player.update({
            where: { id: existingPlayer.id },
            data: {
              name: createPlayerDto.name,
              studentId: createPlayerDto.studentId,
              jerseyNumber: createPlayerDto.jerseyNumber,
              teamId: createPlayerDto.teamId,
              photo: createPlayerDto.photo || existingPlayer.photo || undefined,
              deletedAt: null,
            },
            include: { team: true },
          });

          await this.syncPlayerToSeason(tx, updatedPlayer, targetSeasonId);

          await this.auditLogService.log(
            username,
            'UPDATE_PLAYER',
            `导入/关联球员: "${createPlayerDto.name}" (学号: ${createPlayerDto.studentId})`,
            tx,
          );

          return updatedPlayer;
        }
      }

      const { seasonId: dtoSeasonId, ...playerData } = createPlayerDto;
      const newPlayer = await tx.player.create({
        data: playerData,
        include: { team: true },
      });

      await this.syncPlayerToSeason(tx, newPlayer, targetSeasonId);

      await this.auditLogService.log(
        username,
        'CREATE_PLAYER',
        `新增球员: "${createPlayerDto.name}" (学号: ${createPlayerDto.studentId})`,
        tx,
      );

      return newPlayer;
    });
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

  async update(id: string, updatePlayerDto: UpdatePlayerDto & { seasonId?: string }, username: string, userCtx?: any) {
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

    const { seasonId, ...updateData } = updatePlayerDto;
    const updatedPlayer = await this.prisma.player.update({
      where: { id },
      data: updateData,
      include: { team: true },
    });

    let targetSeasonId = seasonId;
    if (!targetSeasonId) {
      const activeSeason = await this.prisma.season.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
      targetSeasonId = activeSeason?.id;
    }

    if (targetSeasonId) {
      await this.syncPlayerToSeason(null, updatedPlayer, targetSeasonId);
    }

    const diffs: string[] = [];
    if (updatePlayerDto.name !== undefined && updatePlayerDto.name !== player.name) {
      diffs.push(`姓名: ${player.name}->${updatePlayerDto.name}`);
    }
    if (
      updatePlayerDto.jerseyNumber !== undefined &&
      updatePlayerDto.jerseyNumber !== player.jerseyNumber
    ) {
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
      const newTeam = await this.prisma.team.findUnique({
        where: { id: updatePlayerDto.teamId || '' },
      });
      diffs.push(`球队: ${oldTeam?.teamName || '无'}->${newTeam?.teamName || '无'}`);
    }

    const details =
      diffs.length > 0
        ? `修改球员 "${player.name}" 信息: ${diffs.join(', ')}`
        : `保存球员 "${player.name}" 信息(未改动)`;

    await this.auditLogService.log(username, 'UPDATE_PLAYER', details);

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
        studentId: `${player.studentId}_deleted_${timestamp}`,
      },
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

    // 1. 获取该球员报名参加的所有赛季
    const seasonPlayers = await this.prisma.seasonTeamPlayer.findMany({
      where: { playerId: id },
      include: { season: true },
    });

    // 2. 获取所有的进球、红黄牌等事件
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

    // 3. 计算出场数 (Player appearances) - 通过 MatchLineup 统计实际出场
    const lineups = await this.prisma.matchLineup.findMany({
      where: {
        playerId: id,
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

    // 统计每个赛季的数据
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

    const ensureSeasonInit = (season?: { id: string; name: string } | null) => {
      if (!season || !season.id) return;
      if (!seasonStats[season.id]) {
        seasonStats[season.id] = {
          seasonId: season.id,
          seasonName: season.name,
          goals: 0,
          assists: 0,
          yellowCards: 0,
          redCards: 0,
        };
      }
    };

    // 用报名赛季初始化
    seasonPlayers.forEach((sp) => ensureSeasonInit(sp.season));

    // 用出场记录关联的赛季初始化
    lineups.forEach((lineup) => ensureSeasonInit(lineup.match?.season));

    // 用事件关联的赛季初始化
    events.forEach((event) => ensureSeasonInit(event.match?.season));

    // 累计比赛事件统计
    events.forEach((event) => {
      const seasonId = event.match?.season?.id;
      if (!seasonId || !seasonStats[seasonId]) return;

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

    // 计算出场数
    const matchCountsBySeason: Record<string, number> = {};
    lineups.forEach((lineup) => {
      const sId = lineup.match?.season?.id;
      if (sId) {
        matchCountsBySeason[sId] = (matchCountsBySeason[sId] || 0) + 1;
      }
    });

    // 组装最终结果
    const career = Object.values(seasonStats).map((s) => {
      const appearances = matchCountsBySeason[s.seasonId] || 0;
      return {
        ...s,
        appearances,
      };
    });

    return {
      player,
      career,
    };
  }
}
