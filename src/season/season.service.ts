import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { SeasonStatisticsService } from '../prisma/season-statistics.service';
import { getSeasonGender } from '../common/season-gender';

@Injectable()
export class SeasonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly seasonStatistics: SeasonStatisticsService,
  ) {}

  async getSeasons() {
    return this.prisma.season.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async getActiveSeason() {
    const active = await this.prisma.season.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    if (!active) {
      throw new BadRequestException('当前没有活跃的赛季，请新建或激活一个赛季');
    }
    return active;
  }

  async archiveAndCreateNewSeason(name: string, type: string, username: string) {
    if (!name || name.trim() === '') {
      throw new BadRequestException('新赛季名称不能为空');
    }

    const trimmedName = name.trim();

    // 检查名称是否重复
    const existing = await this.prisma.season.findUnique({
      where: { name: trimmedName },
    });
    if (existing) {
      throw new BadRequestException(`赛季名称 "${trimmedName}" 已存在`);
    }

    // 在事务中执行归档与重置
    const newSeason = await this.prisma.$transaction(async (tx) => {
      // 1. 将所有现有的活跃赛季标记为 archived
      await tx.season.updateMany({
        where: { status: 'active' },
        data: { status: 'archived' },
      });

      // 2. 创建新的活跃赛季
      const season = await tx.season.create({
        data: {
          name: trimmedName,
          status: 'active',
          type: type || 'LEAGUE',
        },
      });

      // 3. 将所有未删除的活跃球员一键自动登记注册进新赛季的名册表 SeasonTeamPlayer 中
      const seasonGender = getSeasonGender(trimmedName);
      const activePlayers = await tx.player.findMany({
        where: {
          deletedAt: null,
          ...(seasonGender ? { team: { gender: seasonGender } } : {}),
        },
      });

      if (activePlayers.length > 0) {
        await tx.seasonTeamPlayer.createMany({
          data: activePlayers.map((player) => ({
            seasonId: season.id,
            teamId: player.teamId,
            playerId: player.id,
          })),
        });
      }

      // 4. 重置所有球员在新赛季的状态与累计卡片数
      await tx.player.updateMany({
        where: { deletedAt: null },
        data: {
          yellowCards: 0,
          redCards: 0,
          status: 'active',
          suspendedAtMatchId: null,
        },
      });

      return season;
    });

    // 记录审计日志
    await this.auditLogService.log(
      username,
      'ARCHIVE_SEASON',
      `成功归档往期赛季，并开启新赛季 "${trimmedName}"，将存量球员注册到新赛季名册并重置了红黄牌。`,
    );

    return newSeason;
  }

  async getSeasonStandings(id: string) {
    const season = await this.prisma.season.findUnique({
      where: { id },
      select: { standingsCache: true },
    });
    if (!season) {
      throw new BadRequestException('赛季不存在');
    }
    return season.standingsCache || [];
  }

  async getSeasonStats(id: string) {
    const season = await this.prisma.season.findUnique({
      where: { id },
      select: { statsCache: true },
    });
    if (!season) {
      throw new BadRequestException('赛季不存在');
    }
    return season.statsCache || { scorers: [], assists: [], cards: [] };
  }

  async getSeasonGroups(seasonId: string) {
    return this.prisma.seasonGroupTeam.findMany({
      where: { seasonId },
      include: { team: true },
      orderBy: { groupName: 'asc' },
    });
  }

  async updateSeasonGroups(
    seasonId: string,
    groups: { teamId: string; groupName: string }[],
    username: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // 1. 删除已有的分组映射
      await tx.seasonGroupTeam.deleteMany({
        where: { seasonId },
      });

      // 2. 写入新的分组映射
      if (groups && groups.length > 0) {
        await tx.seasonGroupTeam.createMany({
          data: groups.map((g) => ({
            seasonId,
            teamId: g.teamId,
            groupName: g.groupName,
          })),
        });
      }
    });

    // 3. 重算本赛季的积分榜以刷新缓存
    const cacheResult = await this.seasonStatistics.computeAndCache(seasonId);
    if (!cacheResult.success) {
      console.error(`[Season Groups] 积分榜缓存更新失败: ${cacheResult.error}`);
      // 缓存更新失败不影响分组操作的成功返回，但记录警告
    }

    // 记录审计日志
    await this.auditLogService.log(
      username,
      'UPDATE_SEASON_GROUPS',
      `更新了赛季 ID 为 ${seasonId} 的小组赛分组配置，共分配 ${groups.length} 支球队。`,
    );

    return { success: true };
  }

  async generateKnockoutMatches(seasonId: string, username: string) {
    const season = await this.prisma.season.findUnique({
      where: { id: seasonId },
    });
    if (!season || season.type !== 'CUP') {
      throw new BadRequestException('该赛季不是杯赛，无法生成淘汰赛对阵');
    }

    const standingsCache = season.standingsCache as any;
    if (!standingsCache || !standingsCache.groups) {
      throw new BadRequestException(
        '未找到小组赛积分缓存，请先进行小组赛或录入小组赛比赛结果以更新积分榜',
      );
    }

    const groups = standingsCache.groups;
    const groupNames = Object.keys(groups).sort();

    let round = '';
    const matchPairs: { index: number; homeTeamId: string; awayTeamId: string }[] = [];

    const getTeamId = (groupName: string, rank: number): string | null => {
      const list = groups[groupName];
      if (list && list[rank - 1]) {
        return list[rank - 1].teamId;
      }
      return null;
    };

    if (groupNames.length === 8) {
      // 8个小组 (A-H)，前两名出线，进入16强 (R16)
      round = 'R16';
      const pairings = [
        { index: 1, homeG: 'A', homeR: 1, awayG: 'B', awayR: 2 },
        { index: 2, homeG: 'C', homeR: 1, awayG: 'D', awayR: 2 },
        { index: 3, homeG: 'E', homeR: 1, awayG: 'F', awayR: 2 },
        { index: 4, homeG: 'G', homeR: 1, awayG: 'H', awayR: 2 },
        { index: 5, homeG: 'B', homeR: 1, awayG: 'A', awayR: 2 },
        { index: 6, homeG: 'D', homeR: 1, awayG: 'C', awayR: 2 },
        { index: 7, homeG: 'F', homeR: 1, awayG: 'E', awayR: 2 },
        { index: 8, homeG: 'H', homeR: 1, awayG: 'G', awayR: 2 },
      ];
      pairings.forEach((p) => {
        const home = getTeamId(p.homeG, p.homeR);
        const away = getTeamId(p.awayG, p.awayR);
        if (home && away) {
          matchPairs.push({ index: p.index, homeTeamId: home, awayTeamId: away });
        }
      });
    } else if (groupNames.length === 4) {
      // 4个小组 (A-D)，前两名出线，进入8强 (QF)
      round = 'QF';
      const pairings = [
        { index: 1, homeG: 'A', homeR: 1, awayG: 'B', awayR: 2 },
        { index: 2, homeG: 'C', homeR: 1, awayG: 'D', awayR: 2 },
        { index: 3, homeG: 'B', homeR: 1, awayG: 'A', awayR: 2 },
        { index: 4, homeG: 'D', homeR: 1, awayG: 'C', awayR: 2 },
      ];
      pairings.forEach((p) => {
        const home = getTeamId(p.homeG, p.homeR);
        const away = getTeamId(p.awayG, p.awayR);
        if (home && away) {
          matchPairs.push({ index: p.index, homeTeamId: home, awayTeamId: away });
        }
      });
    } else if (groupNames.length === 2) {
      // 2个小组 (A-B)，前两名出线，进入4强半决赛 (SF)
      round = 'SF';
      const pairings = [
        { index: 1, homeG: 'A', homeR: 1, awayG: 'B', awayR: 2 },
        { index: 2, homeG: 'B', homeR: 1, awayG: 'A', awayR: 2 },
      ];
      pairings.forEach((p) => {
        const home = getTeamId(p.homeG, p.homeR);
        const away = getTeamId(p.awayG, p.awayR);
        if (home && away) {
          matchPairs.push({ index: p.index, homeTeamId: home, awayTeamId: away });
        }
      });
    } else {
      throw new BadRequestException(
        `不支持的小组数量 (${groupNames.length} 个小组)，请手动在对阵图或比赛管理中录入对阵球队`,
      );
    }

    if (matchPairs.length === 0) {
      throw new BadRequestException('小组积分数据不足以提取出线队伍，请先完善小组赛结果');
    }

    // 开启数据库事务，更新或创建这些比赛
    let countCreated = 0;
    let countUpdated = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const pair of matchPairs) {
        const existingMatch = await tx.match.findFirst({
          where: {
            seasonId,
            stage: 'KNOCKOUT',
            knockoutRound: round,
            knockoutMatchIndex: pair.index,
            deletedAt: null,
          },
        });

        if (existingMatch) {
          // 如果比赛已存在，则更新队伍
          await tx.match.update({
            where: { id: existingMatch.id },
            data: {
              homeTeamId: pair.homeTeamId,
              awayTeamId: pair.awayTeamId,
            },
          });
          countUpdated++;
        } else {
          // 创建新比赛
          await tx.match.create({
            data: {
              seasonId,
              homeTeamId: pair.homeTeamId,
              awayTeamId: pair.awayTeamId,
              stage: 'KNOCKOUT',
              knockoutRound: round,
              knockoutMatchIndex: pair.index,
              matchDate: new Date(),
              location: '待定',
              status: 'scheduled',
            },
          });
          countCreated++;
        }
      }
    });

    await this.auditLogService.log(
      username,
      'GENERATE_KNOCKOUT_MATCHES',
      `为赛季 ${seasonId} 一键生成/更新了首轮淘汰赛对局（轮次: ${round}），新建了 ${countCreated} 场比赛，更新了 ${countUpdated} 场比赛。`,
    );

    return { success: true, round, countCreated, countUpdated };
  }

  async createSeason(name: string, type: string, username: string) {
    if (!name || name.trim() === '') {
      throw new BadRequestException('赛季名称不能为空');
    }

    const trimmedName = name.trim();

    // 检查名称是否重复
    const existing = await this.prisma.season.findUnique({
      where: { name: trimmedName },
    });
    if (existing) {
      throw new BadRequestException(`赛季名称 "${trimmedName}" 已存在`);
    }

    const newSeason = await this.prisma.$transaction(async (tx) => {
      // 1. 创建新的活跃赛季
      const season = await tx.season.create({
        data: {
          name: trimmedName,
          status: 'active',
          type: type || 'LEAGUE',
        },
      });

      // 2. 将所有未删除的活跃球员登记注册进新赛季的名册表 SeasonTeamPlayer 中
      const seasonGender = getSeasonGender(trimmedName);
      const activePlayers = await tx.player.findMany({
        where: {
          deletedAt: null,
          ...(seasonGender ? { team: { gender: seasonGender } } : {}),
        },
      });

      if (activePlayers.length > 0) {
        await tx.seasonTeamPlayer.createMany({
          data: activePlayers.map((player) => ({
            seasonId: season.id,
            teamId: player.teamId,
            playerId: player.id,
          })),
        });
      }

      // 3. 重置所有球员在系统的状态与累计卡片数
      await tx.player.updateMany({
        where: { deletedAt: null },
        data: {
          yellowCards: 0,
          redCards: 0,
          status: 'active',
          suspendedAtMatchId: null,
        },
      });

      return season;
    });

    // 记录审计日志
    await this.auditLogService.log(
      username,
      'CREATE_SEASON',
      `成功创建新赛季 "${trimmedName}"，将存量球员注册到新赛季名册并重置了红黄牌。`,
    );

    return newSeason;
  }

  async updateSeasonStatus(id: string, status: string, username: string) {
    if (!['active', 'archived'].includes(status)) {
      throw new BadRequestException('不支持的赛季状态，必须为 active 或 archived');
    }

    const season = await this.prisma.season.findUnique({
      where: { id },
    });
    if (!season) {
      throw new BadRequestException('赛季不存在');
    }

    const updatedSeason = await this.prisma.season.update({
      where: { id },
      data: { status },
    });

    // 记录审计日志
    await this.auditLogService.log(
      username,
      'UPDATE_SEASON_STATUS',
      `修改了赛季 "${season.name}" 的状态为 "${status === 'active' ? '活跃' : '归档'}"。`,
    );

    return updatedSeason;
  }

  async renameSeason(id: string, name: string, username: string) {
    const trimmedName = name?.trim();
    if (!trimmedName) {
      throw new BadRequestException('赛季名称不能为空');
    }

    const season = await this.prisma.season.findUnique({ where: { id } });
    if (!season) {
      throw new BadRequestException('赛季不存在');
    }

    const duplicate = await this.prisma.season.findFirst({
      where: { name: trimmedName, id: { not: id } },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException(`赛季名称 "${trimmedName}" 已存在`);
    }

    const updatedSeason = await this.prisma.season.update({
      where: { id },
      data: { name: trimmedName },
    });

    await this.auditLogService.log(
      username,
      'RENAME_SEASON',
      `将赛季 "${season.name}" 重命名为 "${trimmedName}"`,
    );

    return updatedSeason;
  }

  async deleteSeason(id: string, username: string) {
    const season = await this.prisma.season.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        _count: {
          select: {
            matches: true,
            teamPlayers: true,
            groupTeams: true,
          },
        },
      },
    });
    if (!season) {
      throw new BadRequestException('赛季不存在');
    }

    await this.prisma.$transaction(async (tx) => {
      // MatchLineup、Goal 和 MatchEvent 会随比赛级联删除；
      // SeasonTeamPlayer 和 SeasonGroupTeam 会随赛季级联删除。
      await tx.match.deleteMany({ where: { seasonId: id } });
      await tx.season.delete({ where: { id } });
    });

    await this.auditLogService.log(
      username,
      'DELETE_SEASON',
      `删除赛季 "${season.name}"，同时删除 ${season._count.matches} 场比赛、${season._count.teamPlayers} 条赛季名单和 ${season._count.groupTeams} 条分组记录`,
    );

    return {
      success: true,
      deleted: {
        id: season.id,
        name: season.name,
        matches: season._count.matches,
        teamPlayers: season._count.teamPlayers,
        groupTeams: season._count.groupTeams,
      },
    };
  }
}
