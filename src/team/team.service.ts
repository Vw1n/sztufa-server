import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class TeamService {
  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(createTeamDto: CreateTeamDto, username: string = 'admin') {
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

  async findAll(page: number = 1, limit: number = 10) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;
    const [data, total] = await Promise.all([
      this.prisma.team.findMany({
        skip,
        take: limitNum,
        where: { deletedAt: null },
        include: { players: { where: { deletedAt: null } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.team.count({ where: { deletedAt: null } }),
    ]);
    return { data, total, page: pageNum, limit: limitNum };
  }

  async findOne(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { players: { where: { deletedAt: null } } },
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

    const updatedTeam = await this.prisma.team.update({
      where: { id },
      data: updateTeamDto,
      include: { players: { where: { deletedAt: null } } },
    });

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

    for (const player of teamPlayers) {
      await this.prisma.player.update({
        where: { id: player.id },
        data: {
          deletedAt: new Date(),
          studentId: `${player.studentId}_deleted_${timestamp}`
        }
      });
    }

    // 2. 软删除该球队并释放唯一队名约束
    const deletedTeam = await this.prisma.team.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        teamName: `${team.teamName}_deleted_${timestamp}`
      }
    });

    await this.auditLogService.log(
      username,
      'DELETE_TEAM',
      `删除球队: "${team.teamName}" (级联删除球员 ${teamPlayers.length} 人)`,
    );

    return deletedTeam;
  }

  async searchByName(name: string) {
    return this.prisma.team.findMany({
      where: { teamName: { contains: name }, deletedAt: null },
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
