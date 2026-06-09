import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';

@Injectable()
export class TeamService {
  constructor(private prisma: PrismaService) {}

  async create(createTeamDto: CreateTeamDto) {
    return this.prisma.team.create({
      data: createTeamDto,
      include: { players: true },
    });
  }

  async findAll(page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.team.findMany({
        skip,
        take: limit,
        include: { players: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.team.count(),
    ]);
    return { data, total, page, limit };
  }

  async findOne(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { players: true },
    });
    if (!team) {
      throw new NotFoundException('球队不存在');
    }
    return team;
  }

  async update(id: string, updateTeamDto: UpdateTeamDto) {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team) {
      throw new NotFoundException('球队不存在');
    }
    return this.prisma.team.update({
      where: { id },
      data: updateTeamDto,
      include: { players: true },
    });
  }

  async remove(id: string) {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team) {
      throw new NotFoundException('球队不存在');
    }
    return this.prisma.team.delete({ where: { id } });
  }

  async searchByName(name: string) {
    return this.prisma.team.findMany({
      where: { teamName: { contains: name } },
      include: { players: true },
    });
  }
}
