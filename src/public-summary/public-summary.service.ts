import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublicSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary() {
    const [matchCount, playerCount, teamCount] = await Promise.all([
      this.prisma.match.count({ where: { deletedAt: null } }),
      this.prisma.player.count({ where: { deletedAt: null } }),
      this.prisma.team.count({ where: { deletedAt: null } }),
    ]);

    return { matchCount, playerCount, teamCount };
  }
}
