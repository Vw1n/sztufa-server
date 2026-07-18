import { BadRequestException, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { CreateTeamWithPlayersDto } from './dto/create-team-with-players.dto';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class TeamService {
  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(createTeamDto: CreateTeamDto, username: string = 'admin') {
    const existingTeam = await this.prisma.team.findFirst({
      where: { teamName: createTeamDto.teamName, deletedAt: null },
    });
    if (existingTeam) {
      throw new ConflictException('该球队名称已存在，请使用其他名称');
    }

    const team = await this.prisma.team.create({
      data: createTeamDto,
      include: { players: { where: { deletedAt: null } } },
    });

    await this.auditLogService.log(
       username,
       'CREATE_TEAM',
       `创建球队: "${team.teamName}"`,
     );

    return team;
  }

  async createWithPlayers(dto: CreateTeamWithPlayersDto, username: string = 'admin') {
    const { players = [], seasonId, ...teamData } = dto;
    const normalizedPlayers = players.map((player) => ({
      ...player,
      name: player.name.trim(),
      studentId: player.studentId.trim(),
      jerseyNumber: player.jerseyNumber.trim(),
    }));

    if (normalizedPlayers.length === 0) {
      throw new BadRequestException('请至少添加一名球员');
    }

    const studentIds = new Set<string>();
    const jerseyNumbers = new Set<string>();
    for (const player of normalizedPlayers) {
      if (!player.name || !player.studentId || !player.jerseyNumber) {
        throw new BadRequestException('球员姓名、学号和球衣号码不能为空');
      }
      if (studentIds.has(player.studentId)) {
        throw new ConflictException(`球员学号重复: ${player.studentId}`);
      }
      if (jerseyNumbers.has(player.jerseyNumber)) {
        throw new ConflictException(`球队内球衣号码重复: ${player.jerseyNumber}`);
      }
      studentIds.add(player.studentId);
      jerseyNumbers.add(player.jerseyNumber);
    }

    return this.prisma.$transaction(async (tx) => {
      const targetSeason = await tx.season.findUnique({
        where: { id: seasonId },
        select: { id: true, name: true, status: true },
      });
      if (!targetSeason || targetSeason.status !== 'active') {
        throw new BadRequestException('所选赛季不存在或已不是活跃赛季');
      }

      const seasonGender = targetSeason.name.includes('女')
        ? 'FEMALE'
        : targetSeason.name.includes('男')
          ? 'MALE'
          : null;
      const teamGender = teamData.gender || 'MALE';
      if (seasonGender && seasonGender !== teamGender) {
        throw new BadRequestException('球队组别与所选赛季不匹配');
      }

      const existingTeam = await tx.team.findFirst({
        where: { teamName: teamData.teamName, deletedAt: null },
      });
      if (existingTeam) {
        throw new ConflictException('该球队名称已存在，请使用其他名称');
      }

      const team = await tx.team.create({ data: teamData });

      for (const player of normalizedPlayers) {
        const existingPlayer = await tx.player.findFirst({
          where: {
            OR: [
              { studentId: player.studentId },
              { studentId: { startsWith: `${player.studentId}_deleted_` } },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existingPlayer?.deletedAt === null) {
          throw new ConflictException(`学号 ${player.studentId} 已被其他在籍球员使用`);
        }

        const savedPlayer = existingPlayer
          ? await tx.player.update({
              where: { id: existingPlayer.id },
              data: {
                ...player,
                photo: player.photo || existingPlayer.photo || null,
                teamId: team.id,
                deletedAt: null,
              },
            })
          : await tx.player.create({
              data: {
                ...player,
                photo: player.photo || null,
                teamId: team.id,
              },
            });

        await tx.seasonTeamPlayer.upsert({
          where: {
            seasonId_playerId: {
              seasonId: targetSeason.id,
              playerId: savedPlayer.id,
            },
          },
          create: {
            seasonId: targetSeason.id,
            teamId: team.id,
            playerId: savedPlayer.id,
          },
          update: { teamId: team.id },
        });
      }

      await tx.auditLog.create({
        data: {
          username,
          action: 'CREATE_TEAM',
          details: `创建球队: "${team.teamName}" (赛季 ${targetSeason.name}，球员 ${normalizedPlayers.length} 人)`,
        },
      });

      return tx.team.findUnique({
        where: { id: team.id },
        include: { players: { where: { deletedAt: null } } },
      });
    }, { timeout: 30000 });
  }

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
        { awayMatches: { some: { seasonId } } }
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.team.findMany({
        skip,
        take: limitNum,
        where,
        include: { players: { where: { deletedAt: null } }, groupTeams: true },
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

  async update(id: string, updateTeamDto: UpdateTeamDto, username: string = 'admin') {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team || team.deletedAt !== null) {
      throw new NotFoundException('球队不存在');
    }

    if (updateTeamDto.teamName && updateTeamDto.teamName !== team.teamName) {
      const existingTeam = await this.prisma.team.findFirst({
        where: { teamName: updateTeamDto.teamName, deletedAt: null },
      });
      if (existingTeam) {
        throw new ConflictException('该球队名称已存在，请使用其他名称');
      }
    }

    const updatedTeam = await this.prisma.team.update({
      where: { id },
      data: updateTeamDto,
      include: { players: { where: { deletedAt: null } } },
    });

    // 重新计算并缓存该球队所涉及的所有赛季的数据，以更新前台积分榜、射手榜、助攻榜的队徽
    try {
      const seasons = await this.prisma.season.findMany();
      for (const season of seasons) {
        await this.prisma.computeAndCacheSeasonStats(season.id);
      }
    } catch (cacheErr) {
      console.error('更新球队队徽后重建积分榜统计缓存失败:', cacheErr);
    }

    const diffs: string[] = [];
    if (updateTeamDto.teamName !== undefined && updateTeamDto.teamName !== team.teamName) {
      diffs.push(`队名: ${team.teamName}->${updateTeamDto.teamName}`);
    }
    if (updateTeamDto.teamLogo !== undefined && updateTeamDto.teamLogo !== team.teamLogo) {
      diffs.push(`更新队徽`);
    }
    if (updateTeamDto.headCoach !== undefined && updateTeamDto.headCoach !== team.headCoach) {
      diffs.push(`主教练: ${team.headCoach || '无'}->${updateTeamDto.headCoach || '无'}`);
    }
    if (updateTeamDto.coachPhone !== undefined && updateTeamDto.coachPhone !== team.coachPhone) {
      diffs.push(`教练电话: ${team.coachPhone || '无'}->${updateTeamDto.coachPhone || '无'}`);
    }
    if (updateTeamDto.teamLeader !== undefined && updateTeamDto.teamLeader !== team.teamLeader) {
      diffs.push(`队长: ${team.teamLeader || '无'}->${updateTeamDto.teamLeader || '无'}`);
    }
    if (updateTeamDto.leaderPhone !== undefined && updateTeamDto.leaderPhone !== team.leaderPhone) {
      diffs.push(`队长电话: ${team.leaderPhone || '无'}->${updateTeamDto.leaderPhone || '无'}`);
    }
    if (updateTeamDto.teamDoctor !== undefined && updateTeamDto.teamDoctor !== team.teamDoctor) {
      diffs.push(`队医: ${team.teamDoctor || '无'}->${updateTeamDto.teamDoctor || '无'}`);
    }
    if (updateTeamDto.homeJerseyColor !== undefined && updateTeamDto.homeJerseyColor !== team.homeJerseyColor) {
      diffs.push(`主场球衣: ${team.homeJerseyColor || '无'}->${updateTeamDto.homeJerseyColor || '无'}`);
    }
    if (updateTeamDto.awayJerseyColor !== undefined && updateTeamDto.awayJerseyColor !== team.awayJerseyColor) {
      diffs.push(`客场球衣: ${team.awayJerseyColor || '无'}->${updateTeamDto.awayJerseyColor || '无'}`);
    }

    const details = diffs.length > 0
      ? `修改球队 "${team.teamName}" 信息: ${diffs.join(', ')}`
      : `保存球队 "${team.teamName}" 信息(未改动)`;

    await this.auditLogService.log(username, 'UPDATE_TEAM', details);

    return updatedTeam;
  }

  async remove(id: string, username: string = 'admin') {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team || team.deletedAt !== null) {
      throw new NotFoundException('球队不存在');
    }
    
    const timestamp = Date.now();

    // 1. 级联软删除该球队名下的所有在队球员，并安全释放其学号唯一键约束以防冲突
    const teamPlayers = await this.prisma.player.findMany({
      where: { teamId: id, deletedAt: null }
    });

    const deletedTeam = await this.prisma.$transaction(async (tx) => {
      for (const player of teamPlayers) {
        await tx.player.update({
          where: { id: player.id },
          data: {
            deletedAt: new Date(),
            studentId: `${player.studentId}_deleted_${timestamp}`
          }
        });
      }

      // 2. 软删除该球队并释放唯一队名约束
      return tx.team.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          teamName: `${team.teamName}_deleted_${timestamp}`
        }
      });
    });

    await this.auditLogService.log(
      username,
      'DELETE_TEAM',
      `删除球队: "${team.teamName}" (级联删除球员 ${teamPlayers.length} 人)`,
    );

    return deletedTeam;
  }

  async searchByName(name: string) {
    if (!name || name.trim() === '') {
      return [];
    }
    return this.prisma.team.findMany({
      where: { teamName: { contains: name.trim() }, deletedAt: null },
      include: { players: { where: { deletedAt: null } } },
    });
  }

  async getTeamRoster(teamId: string, seasonId?: string) {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId }
    });
    if (!team || team.deletedAt !== null) {
      throw new NotFoundException('球队不存在');
    }

    let targetSeasonId = seasonId;
    if (!targetSeasonId) {
      const activeSeason = await this.prisma.season.findFirst({
        where: { status: 'active' }
      });
      if (!activeSeason) {
        throw new NotFoundException('当前无活跃赛季');
      }
      targetSeasonId = activeSeason.id;
    }

    const rosterRecords = await this.prisma.seasonTeamPlayer.findMany({
      where: {
        seasonId: targetSeasonId,
        teamId: teamId,
        player: {
          deletedAt: null
        }
      },
      include: {
        player: true
      }
    });

    return rosterRecords
      .map(r => r.player)
      .sort((a, b) => {
        const numA = parseInt(a.jerseyNumber, 10) || 999;
        const numB = parseInt(b.jerseyNumber, 10) || 999;
        return numA - numB;
      });
  }
}
