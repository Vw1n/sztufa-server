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

      // 3. 重置所有球员在新赛季的状态与累计卡片数
      await tx.player.updateMany({
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
        `成功归档往期赛季，并开启新赛季 "${trimmedName}"，重置了所有球员的红黄牌与可用状态。`,
      );

      return newSeason;
    });
  }
}
