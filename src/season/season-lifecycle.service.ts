import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BackupService } from '../backup/backup.service';

@Injectable()
export class SeasonLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly backupService: BackupService,
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

    const now = new Date();
    const transitionedSeasonIds: string[] = [];

    const newSeason = await this.prisma.$transaction(async (tx) => {
      // 严格在事务内查询当前所有处于 active 的赛季，杜绝事务外并发新增/激活产生的孤儿归档
      const targetActiveSeasons = await tx.season.findMany({
        where: { status: 'active' },
        select: { id: true },
      });

      for (const season of targetActiveSeasons) {
        const updateRes = await tx.season.updateMany({
          where: { id: season.id, status: 'active' },
          data: { status: 'archived', archivedAt: now },
        });

        // 仅当实际成功从 active 转换为 archived 时才登记任务
        if (updateRes.count === 1) {
          transitionedSeasonIds.push(season.id);

          const existingRun = await tx.backupRun.findUnique({
            where: { taskKey: `archive:season:${season.id}` },
          });

          // 防并发重置：若当前已有 running 状态的任务，绝不重置其 attempts 与运行态
          if (
            !existingRun ||
            (existingRun.status !== 'running' && existingRun.status !== 'succeeded')
          ) {
            await tx.backupRun.upsert({
              where: { taskKey: `archive:season:${season.id}` },
              update: {
                status: 'pending',
                trigger: 'archive',
                purpose: 'archive',
                selectorKey: `season:${season.id}`,
                attempts: 0,
                nextAttemptAt: now,
                failureCode: null,
                failureMessage: null,
                finishedAt: null,
              },
              create: {
                taskKey: `archive:season:${season.id}`,
                trigger: 'archive',
                scope: 'module',
                module: 'season',
                selectorKey: `season:${season.id}`,
                purpose: 'archive',
                status: 'pending',
                attempts: 0,
                nextAttemptAt: now,
              },
            });
          }
        }
      }

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

    for (const seasonId of transitionedSeasonIds) {
      await this.backupService.executePendingArchiveBackup(seasonId, username);
    }

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

    let shouldTriggerBackup = false;
    const now = new Date();

    const updatedSeason = await this.prisma.$transaction(async (tx) => {
      if (status === 'archived') {
        const updateResult = await tx.season.updateMany({
          where: { id, status: 'active' },
          data: { status: 'archived', archivedAt: now },
        });
        if (updateResult.count === 1) {
          shouldTriggerBackup = true;
          const existingRun = await tx.backupRun.findUnique({
            where: { taskKey: `archive:season:${id}` },
          });
          if (
            !existingRun ||
            (existingRun.status !== 'running' && existingRun.status !== 'succeeded')
          ) {
            await tx.backupRun.upsert({
              where: { taskKey: `archive:season:${id}` },
              update: {
                status: 'pending',
                trigger: 'archive',
                purpose: 'archive',
                selectorKey: `season:${id}`,
                attempts: 0,
                nextAttemptAt: now,
                failureCode: null,
                failureMessage: null,
                finishedAt: null,
              },
              create: {
                taskKey: `archive:season:${id}`,
                trigger: 'archive',
                scope: 'module',
                module: 'season',
                selectorKey: `season:${id}`,
                purpose: 'archive',
                status: 'pending',
                attempts: 0,
                nextAttemptAt: now,
              },
            });
          }
        }
      } else {
        await tx.season.update({
          where: { id },
          data: { status },
        });
      }
      return tx.season.findUnique({ where: { id } });
    });

    if (shouldTriggerBackup) {
      await this.backupService.executePendingArchiveBackup(id, username);
    }

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
}
