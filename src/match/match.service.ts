import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMatchDto } from './dto/create-match.dto';
import { UpdateMatchDto } from './dto/update-match.dto';

@Injectable()
export class MatchService {
  constructor(private prisma: PrismaService) {}

  async create(createMatchDto: CreateMatchDto) {
    const [homeTeam, awayTeam] = await Promise.all([
      this.prisma.team.findUnique({ where: { id: createMatchDto.homeTeamId } }),
      this.prisma.team.findUnique({ where: { id: createMatchDto.awayTeamId } }),
    ]);

    if (!homeTeam) {
      throw new NotFoundException('主队不存在');
    }
    if (!awayTeam) {
      throw new NotFoundException('客队不存在');
    }

    return this.prisma.match.create({
      data: createMatchDto,
      include: { homeTeam: true, awayTeam: true },
    });
  }

  async findAll(page: number = 1, limit: number = 10, teamId?: string) {
    const skip = (page - 1) * limit;
    const where = teamId
      ? {
          OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
        }
      : {};

    const [data, total] = await Promise.all([
      this.prisma.match.findMany({
        skip,
        take: limit,
        where,
        include: { homeTeam: true, awayTeam: true },
        orderBy: { matchDate: 'desc' },
      }),
      this.prisma.match.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: string) {
    const match = await this.prisma.match.findUnique({
      where: { id },
      include: { homeTeam: true, awayTeam: true },
    });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }
    return match;
  }

  async update(id: string, updateMatchDto: UpdateMatchDto) {
    const match = await this.prisma.match.findUnique({ where: { id } });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }

    if (updateMatchDto.homeTeamId) {
      const homeTeam = await this.prisma.team.findUnique({
        where: { id: updateMatchDto.homeTeamId },
      });
      if (!homeTeam) {
        throw new NotFoundException('主队不存在');
      }
    }

    if (updateMatchDto.awayTeamId) {
      const awayTeam = await this.prisma.team.findUnique({
        where: { id: updateMatchDto.awayTeamId },
      });
      if (!awayTeam) {
        throw new NotFoundException('客队不存在');
      }
    }

    return this.prisma.match.update({
      where: { id },
      data: updateMatchDto,
      include: { homeTeam: true, awayTeam: true },
    });
  }

  async remove(id: string) {
    const match = await this.prisma.match.findUnique({ where: { id } });
    if (!match) {
      throw new NotFoundException('比赛不存在');
    }
    return this.prisma.match.delete({ where: { id } });
  }
}
