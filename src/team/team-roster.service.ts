import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TeamRosterService {
  constructor(private readonly prisma: PrismaService) {}

  async validateTargetSeason(
    tx: Prisma.TransactionClient,
    seasonId: string,
    teamGender: string,
  ) {
    const season = await tx.season.findUnique({
      where: { id: seasonId },
      select: { id: true, name: true, status: true },
    });
    if (!season || season.status !== 'active') {
      throw new BadRequestException('所选赛季不存在或已不是活跃赛季');
    }

    const seasonGender = season.name.includes('女')
      ? 'FEMALE'
      : season.name.includes('男')
        ? 'MALE'
        : null;
    if (seasonGender && seasonGender !== teamGender) {
      throw new BadRequestException('球队组别与所选赛季不匹配');
    }
    return season;
  }

  async registerPlayer(
    tx: Prisma.TransactionClient,
    seasonId: string,
    teamId: string,
    playerId: string,
  ) {
    return tx.seasonTeamPlayer.upsert({
      where: { seasonId_playerId: { seasonId, playerId } },
      create: { seasonId, teamId, playerId },
      update: { teamId },
    });
  }

  async getTeamRoster(teamId: string, seasonId?: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team || team.deletedAt !== null) {
      throw new NotFoundException('球队不存在');
    }

    let targetSeasonId = seasonId;
    if (!targetSeasonId) {
      const activeSeason = await this.prisma.season.findFirst({
        where: { status: 'active' },
      });
      if (!activeSeason) {
        throw new NotFoundException('当前无活跃赛季');
      }
      targetSeasonId = activeSeason.id;
    }

    const rosterRecords = await this.prisma.seasonTeamPlayer.findMany({
      where: {
        seasonId: targetSeasonId,
        teamId,
        player: { deletedAt: null },
      },
      include: { player: true },
    });

    return rosterRecords
      .map((record) => record.player)
      .sort((left, right) => {
        const leftParsed = parseInt(left.jerseyNumber, 10);
        const rightParsed = parseInt(right.jerseyNumber, 10);
        const leftNumber = isNaN(leftParsed) ? 999 : leftParsed;
        const rightNumber = isNaN(rightParsed) ? 999 : rightParsed;
        return leftNumber - rightNumber;
      });
  }
}
