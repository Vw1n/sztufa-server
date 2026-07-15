import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class SeasonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async getSeasons() {
    return this.prisma.season.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async getActiveSeason() {
    const active = await this.prisma.season.findFirst({
      where: { status: 'active' },
    });
    if (!active) {
      throw new BadRequestException('当前没有活跃的赛季，请新建或激活一个赛季');
    }
    return active;
  }

  async archiveAndCreateNewSeason(name: string, username: string) {
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
    return this.prisma.$transaction(async (tx) => {
      // 1. 将所有现有的活跃赛季标记为 archived
      await tx.season.updateMany({
        where: { status: 'active' },
        data: { status: 'archived' },
      });

      // 2. 创建新的活跃赛季
      const newSeason = await tx.season.create({
        data: {
          name: trimmedName,
          status: 'active',
        },
      });

      // 3. 将所有未删除的活跃球员一键自动登记注册进新赛季的名册表 SeasonTeamPlayer 中
      const activePlayers = await tx.player.findMany({
        where: { deletedAt: null }
      });

      if (activePlayers.length > 0) {
        await tx.seasonTeamPlayer.createMany({
          data: activePlayers.map((player) => ({
            seasonId: newSeason.id,
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

      // 记录审计日志
      await this.auditLogService.log(
        username,
        'ARCHIVE_SEASON',
        `成功归档往期赛季，并开启新赛季 "${trimmedName}"，将存量球员注册到新赛季名册并重置了红黄牌。`,
      );

      return newSeason;
    });
  }

  async getSeasonStandings(id: string) {
    const season = await this.prisma.season.findUnique({
      where: { id },
      select: { standingsCache: true }
    });
    if (!season) {
      throw new BadRequestException('赛季不存在');
    }
    return season.standingsCache || [];
  }

  async getSeasonStats(id: string) {
    const season = await this.prisma.season.findUnique({
      where: { id },
      select: { statsCache: true }
    });
    if (!season) {
      throw new BadRequestException('赛季不存在');
    }
    return season.statsCache || { scorers: [], assists: [], cards: [] };
  }
}
