import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class KnockoutGeneratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

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
          await tx.match.update({
            where: { id: existingMatch.id },
            data: {
              homeTeamId: pair.homeTeamId,
              awayTeamId: pair.awayTeamId,
            },
          });
          countUpdated++;
        } else {
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
}
