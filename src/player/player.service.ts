import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlayerDto } from './dto/create-player.dto';
import { UpdatePlayerDto } from './dto/update-player.dto';

@Injectable()
export class PlayerService {
  constructor(private prisma: PrismaService) {}

  async create(createPlayerDto: CreatePlayerDto) {
    const team = await this.prisma.team.findUnique({
      where: { id: createPlayerDto.teamId },
    });
    if (!team) {
      throw new NotFoundException('球队不存在');
    }

    // 检查学号是否已存在
    const existingPlayer = await this.prisma.player.findUnique({
      where: { studentId: createPlayerDto.studentId },
    });

    if (existingPlayer) {
      // 如果已存在，则更新球员信息
      return this.prisma.player.update({
        where: { studentId: createPlayerDto.studentId },
        data: {
          name: createPlayerDto.name,
          jerseyNumber: createPlayerDto.jerseyNumber,
          teamId: createPlayerDto.teamId,
          photo: createPlayerDto.photo || existingPlayer.photo || undefined,
        },
        include: { team: true },
      });
    }

    return this.prisma.player.create({
      data: createPlayerDto,
      include: { team: true },
    });
  }

  async findAll(teamId?: string, page: number = 1, limit: number = 10) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;
    const where = teamId ? { teamId } : {};

    const [data, total] = await Promise.all([
      this.prisma.player.findMany({
        skip,
        take: limitNum,
        where,
        include: { team: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.player.count({ where }),
    ]);

    return { data, total, page: pageNum, limit: limitNum };
  }

  async findOne(id: string) {
    const player = await this.prisma.player.findUnique({
      where: { id },
      include: { team: true },
    });
    if (!player) {
      throw new NotFoundException('球员不存在');
    }
    return player;
  }

  async update(id: string, updatePlayerDto: UpdatePlayerDto) {
    const player = await this.prisma.player.findUnique({ where: { id } });
    if (!player) {
      throw new NotFoundException('球员不存在');
    }

    if (updatePlayerDto.teamId) {
      const team = await this.prisma.team.findUnique({
        where: { id: updatePlayerDto.teamId },
      });
      if (!team) {
        throw new NotFoundException('球队不存在');
      }
    }

    return this.prisma.player.update({
      where: { id },
      data: updatePlayerDto,
      include: { team: true },
    });
  }

  async remove(id: string) {
    const player = await this.prisma.player.findUnique({ where: { id } });
    if (!player) {
      throw new NotFoundException('球员不存在');
    }
    return this.prisma.player.delete({ where: { id } });
  }

  async searchByName(name: string) {
    return this.prisma.player.findMany({
      where: { name: { contains: name } },
      include: { team: true },
    });
  }
}
