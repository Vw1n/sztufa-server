import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { SeasonStatisticsService } from '../prisma/season-statistics.service';
import { UpdateSeasonChampionDto } from './dto/update-season-champion.dto';
import { getSeasonGender } from '../common/season-gender';

@Injectable()
export class SeasonLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly seasonStatistics: SeasonStatisticsService,
  ) {}

  async getSeasons() {
    const seasons = await this.prisma.season.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return seasons.sort((left, right) => {
      const leftYear = this.extractSeasonYear(left.name);
      const rightYear = this.extractSeasonYear(right.name);

      if (leftYear !== rightYear) {
        return rightYear - leftYear;
      }
      return left.name.localeCompare(right.name, 'zh-CN');
    });
  }

  private extractSeasonYear(name: string): number {
    const matchedYear = name.match(/(?:19|20)\d{2}/);
    return matchedYear ? Number(matchedYear[0]) : Number.NEGATIVE_INFINITY;
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

  async createSeason(name: string, type: string, username: string) {
    if (!name || name.trim() === '') {
      throw new BadRequestException('赛季名称不能为空');
    }

    const trimmedName = name.trim();

    const existing = await this.prisma.season.findUnique({
      where: { name: trimmedName },
    });
    if (existing) {
      throw new BadRequestException(`赛季名称 "${trimmedName}" 已存在`);
    }

    const newSeason = await this.prisma.$transaction(async (tx) => {
      const season = await tx.season.create({
        data: {
          name: trimmedName,
          status: 'active',
          type: type || 'LEAGUE',
        },
      });

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

    await this.auditLogService.log(
      username,
      'CREATE_SEASON',
      `成功创建新赛季 "${trimmedName}"，新赛季名单为空，并重置了球员红黄牌。`,
    );

    return newSeason;
  }

  async archiveAndCreateNewSeason(name: string, type: string, username: string) {
    if (!name || name.trim() === '') {
      throw new BadRequestException('新赛季名称不能为空');
    }

    const trimmedName = name.trim();

    const existing = await this.prisma.season.findUnique({
      where: { name: trimmedName },
    });
    if (existing) {
      throw new BadRequestException(`赛季名称 "${trimmedName}" 已存在`);
    }

    const newSeason = await this.prisma.$transaction(async (tx) => {
      await tx.season.updateMany({
        where: { status: 'active' },
        data: { status: 'archived' },
      });

      const season = await tx.season.create({
        data: {
          name: trimmedName,
          status: 'active',
          type: type || 'LEAGUE',
        },
      });

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

    await this.auditLogService.log(
      username,
      'ARCHIVE_SEASON',
      `成功归档往期赛季，并开启新赛季 "${trimmedName}"，新赛季名单为空，并重置了球员红黄牌。`,
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

  async getSeasonValidChampionTeamIds(seasonId: string, tx?: any): Promise<Set<string>> {
    const client = tx || this.prisma;
    const season = await client.season.findUnique({ where: { id: seasonId } });
    if (!season) return new Set();

    const stageFilter = { OR: [{ stage: 'LEAGUE' }, { stage: null }] };
    const [seasonPlayers, finishedMatches] = await Promise.all([
      client.seasonTeamPlayer?.findMany
        ? client.seasonTeamPlayer.findMany({
            where: { seasonId },
            include: { team: true },
          })
        : Promise.resolve([]),
      client.match?.findMany
        ? client.match.findMany({
            where: {
              seasonId,
              status: 'finished',
              deletedAt: null,
              AND: [stageFilter],
            },
            include: { homeTeam: true, awayTeam: true },
          })
        : Promise.resolve([]),
    ]);

    const seasonGender = getSeasonGender(season.name) ?? 'MALE';
    const validTeamIds = new Set<string>();
    seasonPlayers.forEach((sp: any) => {
      if (sp.team && sp.team.gender === seasonGender) {
        validTeamIds.add(sp.teamId);
      }
    });
    finishedMatches.forEach((m: any) => {
      if (m.homeTeam && m.homeTeam.gender === seasonGender) {
        validTeamIds.add(m.homeTeamId);
      }
      if (m.awayTeam && m.awayTeam.gender === seasonGender) {
        validTeamIds.add(m.awayTeamId);
      }
    });

    return validTeamIds;
  }

  async updateSeasonChampion(id: string, dto: UpdateSeasonChampionDto, username: string) {
    const season = await this.prisma.season.findUnique({ where: { id } });
    if (!season) {
      throw new BadRequestException('赛季不存在');
    }

    if (season.type !== 'LEAGUE') {
      throw new BadRequestException('仅联赛赛季支持手动指定冠军');
    }

    if (dto.teamId !== null) {
      const validTeamIds = await this.getSeasonValidChampionTeamIds(id);
      if (!validTeamIds.has(dto.teamId)) {
        throw new BadRequestException('指定的球队不属于该赛季参战球队');
      }
    }

    const prevManualId = season.manualChampionTeamId;
    const prevSetBy = season.manualChampionSetBy;
    const prevSetAt = season.manualChampionSetAt;

    let updatedSeason;
    if (dto.teamId !== null) {
      updatedSeason = await this.prisma.season.update({
        where: { id },
        data: {
          manualChampionTeamId: dto.teamId,
          manualChampionSetBy: username,
          manualChampionSetAt: new Date(),
        },
      });
    } else {
      updatedSeason = await this.prisma.season.update({
        where: { id },
        data: {
          manualChampionTeamId: null,
          manualChampionSetBy: null,
          manualChampionSetAt: null,
        },
      });
    }

    const cacheResult = await this.seasonStatistics.computeAndCache(id);
    if (!cacheResult.success) {
      // 缓存计算失败时，回滚数据库冠军更新
      await this.prisma.season.update({
        where: { id },
        data: {
          manualChampionTeamId: prevManualId,
          manualChampionSetBy: prevSetBy,
          manualChampionSetAt: prevSetAt,
        },
      });
      throw new BadRequestException(`更新冠军失败，无法计算积分榜缓存: ${cacheResult.error}`);
    }

    // 缓存更新成功后写入审计日志
    if (dto.teamId !== null) {
      const team = await this.prisma.team.findUnique({ where: { id: dto.teamId } });
      await this.auditLogService.log(
        username,
        'SET_SEASON_CHAMPION',
        `指定了赛季 "${season.name}" 的冠军为球队 "${team?.teamName || dto.teamId}"`,
      );
    } else {
      await this.auditLogService.log(
        username,
        'CLEAR_SEASON_CHAMPION',
        `撤销了赛季 "${season.name}" 的手动指定冠军`,
      );
    }

    return updatedSeason;
  }

  async cleanStaleManualChampion(seasonId: string, tx?: any) {
    const client = tx || this.prisma;
    const season = await client.season.findUnique({ where: { id: seasonId } });
    if (!season || !season.manualChampionTeamId) return;

    const validTeamIds = await this.getSeasonValidChampionTeamIds(seasonId, client);
    if (!validTeamIds.has(season.manualChampionTeamId)) {
      await client.season.update({
        where: { id: seasonId },
        data: {
          manualChampionTeamId: null,
          manualChampionSetBy: null,
          manualChampionSetAt: null,
        },
      });
    }
  }
}
