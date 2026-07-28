import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TeamQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(page: number = 1, limit: number = 10, seasonId?: string, gender?: string) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { deletedAt: null };
    if (gender && gender !== 'all') {
      where.gender = gender;
    }
    if (seasonId && seasonId !== 'all') {
      where.OR = [
        { groupTeams: { some: { seasonId } } },
        { seasonPlayers: { some: { seasonId } } },
        { homeMatches: { some: { seasonId } } },
        { awayMatches: { some: { seasonId } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.team.findMany({
        skip,
        take: limitNum,
        where,
        include: {
          players: {
            where: {
              deletedAt: null,
              ...(seasonId && seasonId !== 'all' ? { seasonPlayers: { some: { seasonId } } } : {}),
            },
          },
          groupTeams: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.team.count({ where }),
    ]);
    return { data, total, page: pageNum, limit: limitNum };
  }

  async findOne(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { players: { where: { deletedAt: null } }, groupTeams: true },
    });
    if (!team || team.deletedAt !== null) {
      throw new NotFoundException('球队不存在');
    }
    return team;
  }

  async searchByName(name: string) {
    if (!name || name.trim() === '') return [];
    return this.prisma.team.findMany({
      where: { teamName: { contains: name.trim() }, deletedAt: null },
      include: { players: { where: { deletedAt: null } } },
    });
  }
}
