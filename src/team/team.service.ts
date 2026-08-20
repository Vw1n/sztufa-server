import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { CreateTeamWithPlayersDto } from './dto/create-team-with-players.dto';
import { UpdateTeamWithPlayersDto } from './dto/update-team-with-players.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TeamRosterService } from './team-roster.service';
import { SeasonStatisticsService } from '../prisma/season-statistics.service';
import { isTeamGenderCompatibleWithSeason } from '../common/season-gender';

@Injectable()
export class TeamService {
  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly teamRosterService: TeamRosterService,
    private readonly seasonStatistics: SeasonStatisticsService,
  ) {}

  async create(
    createTeamDto: CreateTeamDto,
    username: string = 'admin',
    userCtx?: { role?: string },
  ) {
    if (userCtx?.role !== 'super_admin') {
      const existingTeam = await this.prisma.team.findFirst({
        where: { teamName: createTeamDto.teamName, deletedAt: null },
      });
      if (existingTeam) {
        throw new ConflictException('该球队名称已存在，请使用其他名称');
      }
    }

    const team = await this.prisma.team.create({
      data: {
        ...createTeamDto,
        teamName: createTeamDto.teamName || '',
        homeJerseyColor: createTeamDto.homeJerseyColor || '',
        awayJerseyColor: createTeamDto.awayJerseyColor || '',
      },
      include: { players: { where: { deletedAt: null } } },
    });

    await this.afterTeamCommitted(team.id, username);

    return team;
  }

  async afterTeamCommitted(teamId: string, username: string) {
    try {
      if (!this.prisma?.team) return;
      const team = await this.prisma.team.findUnique({ where: { id: teamId } });
      if (team && this.auditLogService) {
        await this.auditLogService.log(
          username,
          'CREATE_TEAM',
          `创建/更新球队: "${team.teamName}"`,
        );
      }
    } catch (err) {
      console.error(`[afterTeamCommitted Error] Failed for team ${teamId}:`, err);
    }
  }

  async createTeamCore(
    tx: any,
    dto: CreateTeamWithPlayersDto,
    username: string = 'admin',
    userCtx?: { role?: string },
  ) {
    const isSuperAdmin = userCtx?.role === 'super_admin';
    const { players = [], seasonId, ...teamData } = dto;

    const normalizedPlayers = players.map((player) => ({
      ...player,
      name: (player.name || '').trim(),
      studentId: (player.studentId || '').trim(),
      jerseyNumber: (player.jerseyNumber || '').trim(),
    }));

    if (!isSuperAdmin) {
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
    }

    let targetSeason: any = null;
    if (seasonId) {
      targetSeason = await this.teamRosterService.validateTargetSeason(
        tx,
        seasonId,
        teamData.gender || 'MALE',
      );
    } else {
      targetSeason = await tx.season.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!targetSeason && !isSuperAdmin) {
      throw new BadRequestException('未提供且系统没有活跃赛季');
    }

    if (!isSuperAdmin && targetSeason) {
      const existingTeam = await tx.team.findFirst({
        where: {
          seasonProfiles: {
            some: { seasonId: targetSeason.id, teamName: teamData.teamName },
          },
        },
      });
      if (existingTeam) {
        throw new ConflictException('该球队已存在于所选赛季中');
      }
    }

    const team = await tx.team.create({
      data: {
        teamName: teamData.teamName || '',
        homeJerseyColor: teamData.homeJerseyColor || '',
        awayJerseyColor: teamData.awayJerseyColor || '',
        gender: teamData.gender || 'MALE',
        teamDoctor: teamData.teamDoctor || null,
        headCoach: teamData.headCoach || null,
        teamLeader: teamData.teamLeader || null,
        coachPhone: teamData.coachPhone || null,
        leaderPhone: teamData.leaderPhone || null,
        teamLogo: teamData.teamLogo || null,
        homeJersey: teamData.homeJersey || null,
        awayJersey: teamData.awayJersey || null,
      },
    });

    if (targetSeason) {
      await tx.seasonTeamProfile.create({
        data: {
          seasonId: targetSeason.id,
          teamId: team.id,
          teamName: teamData.teamName || '',
          teamDoctor: teamData.teamDoctor || null,
          headCoach: teamData.headCoach || null,
          teamLeader: teamData.teamLeader || null,
          coachPhone: teamData.coachPhone || null,
          leaderPhone: teamData.leaderPhone || null,
          homeJerseyColor: teamData.homeJerseyColor || '',
          awayJerseyColor: teamData.awayJerseyColor || '',
          teamLogo: teamData.teamLogo || null,
          homeJersey: teamData.homeJersey || null,
          awayJersey: teamData.awayJersey || null,
          gender: teamData.gender || 'MALE',
          isRegistered: true,
        },
      });
    }

    for (const player of normalizedPlayers) {
      if (isSuperAdmin && !player.name && !player.studentId && !player.jerseyNumber) {
        continue;
      }

      if (!isSuperAdmin && targetSeason) {
        const existingPlayer = await tx.seasonTeamPlayer.findFirst({
          where: {
            seasonId: targetSeason.id,
            player: { studentId: player.studentId, deletedAt: null },
          },
          select: { id: true },
        });

        if (existingPlayer) {
          throw new ConflictException(`球员学号已存在于所选赛季: ${player.studentId}`);
        }
      }

      const savedPlayer = await tx.player.create({
        data: {
          name: player.name || '',
          studentId: player.studentId || '',
          jerseyNumber: player.jerseyNumber || '',
          photo: player.photo || null,
          status: player.status || 'active',
          yellowCards: player.yellowCards ?? 0,
          redCards: player.redCards ?? 0,
          teamId: team.id,
        },
      });

      if (targetSeason) {
        await this.teamRosterService.registerPlayer(tx, targetSeason.id, team.id, savedPlayer);
      }
    }

    await tx.auditLog.create({
      data: {
        username,
        action: 'CREATE_TEAM',
        details: `创建球队: "${team.teamName}" (${targetSeason ? `赛季 ${targetSeason.name}，` : ''}球员 ${normalizedPlayers.length} 人)`,
      },
    });

    return tx.team.findUnique({
      where: { id: team.id },
      include: { players: { where: { deletedAt: null } } },
    });
  }

  async createWithPlayers(
    dto: CreateTeamWithPlayersDto,
    username: string = 'admin',
    userCtx?: { role?: string },
    tx?: any,
  ) {
    if (userCtx && userCtx.role !== 'super_admin') {
      throw new ForbiddenException('仅超级管理员可以创建球队，请联系超级管理员创建并绑定球队');
    }

    const isSuperAdmin = userCtx?.role === 'super_admin';
    const players = dto.players || [];
    const normalizedPlayers = players.map((player) => ({
      ...player,
      name: (player.name || '').trim(),
      studentId: (player.studentId || '').trim(),
      jerseyNumber: (player.jerseyNumber || '').trim(),
    }));

    if (!isSuperAdmin) {
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
    }

    if (tx) {
      return this.createTeamCore(tx, dto, username, userCtx);
    }
    const result = await this.prisma.$transaction(
      async (innerTx) => this.createTeamCore(innerTx, dto, username, userCtx),
      { timeout: 30000 },
    );
    await this.afterTeamCommitted(result.id, username);
    return result;
  }

  async updateWithPlayersCore(
    tx: any,
    teamId: string,
    dto: UpdateTeamWithPlayersDto,
    _username: string = 'admin',
    userCtx?: { role?: string; teamId?: string },
    txParam?: any,
  ) {
    const isSuperAdmin = userCtx?.role === 'super_admin';
    if (userCtx?.role === 'coach' && userCtx.teamId !== teamId) {
      throw new ForbiddenException('您没有权限修改其他球队的信息');
    }

    const runner = txParam || this.prisma;
    const team = await runner.team.findUnique({ where: { id: teamId } });
    if (!team || team.deletedAt !== null) {
      throw new NotFoundException('球队不存在');
    }

    if (dto.teamName && dto.teamName !== team.teamName && !isSuperAdmin) {
      const existing = await runner.team.findFirst({
        where: { teamName: dto.teamName, deletedAt: null },
      });
      if (existing) {
        throw new ConflictException('该球队名称已存在，请使用其他名称');
      }
    }

    const { players = [], deletePlayerIds = [], seasonId, ...teamData } = dto;

    if (!isSuperAdmin) {
      const studentIds = new Set<string>();
      const jerseyNumbers = new Set<string>();
      for (const player of players) {
        const sId = String(player.studentId ?? '').trim();
        const jNum = String(player.jerseyNumber ?? '').trim();
        if (!player.name?.trim() || !sId || jNum === '') {
          throw new BadRequestException('球员姓名、学号和球衣号码不能为空');
        }
        if (studentIds.has(sId)) {
          throw new ConflictException(`球员学号重复: ${sId}`);
        }
        if (jerseyNumbers.has(jNum)) {
          throw new ConflictException(`球队内球衣号码重复: ${jNum}`);
        }
        studentIds.add(sId);
        jerseyNumbers.add(jNum);
      }
    }

    let targetSeason: any = null;
    if (seasonId) {
      targetSeason = await runner.season.findUnique({ where: { id: seasonId } });
    } else {
      targetSeason = await runner.season.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
    }

    const effectiveSeasonId = targetSeason?.id || seasonId;
    if (!effectiveSeasonId) {
      throw new BadRequestException('缺失有效的目标赛季 ID');
    }

    const profileData = { ...team, ...teamData };
    const updatedProfile = await tx.seasonTeamProfile.upsert({
      where: { seasonId_teamId: { seasonId: effectiveSeasonId, teamId } },
      create: {
        seasonId: effectiveSeasonId,
        teamId,
        teamName: profileData.teamName || team.teamName,
        teamDoctor: profileData.teamDoctor,
        headCoach: profileData.headCoach,
        teamLeader: profileData.teamLeader,
        coachPhone: profileData.coachPhone,
        leaderPhone: profileData.leaderPhone,
        homeJerseyColor: profileData.homeJerseyColor,
        awayJerseyColor: profileData.awayJerseyColor,
        teamLogo: profileData.teamLogo,
        homeJersey: profileData.homeJersey,
        awayJersey: profileData.awayJersey,
        gender: profileData.gender || team.gender,
        isRegistered: true,
      },
      update: { ...teamData, isRegistered: true },
    });
    const updatedTeam = { ...team, ...updatedProfile };

    if (targetSeason && !isTeamGenderCompatibleWithSeason(targetSeason.name, updatedTeam.gender)) {
      await tx.seasonTeamPlayer.deleteMany({ where: { seasonId: effectiveSeasonId, teamId } });
    }

    const auditDiffs: string[] = [];

    if (deletePlayerIds.length > 0) {
      for (const playerId of deletePlayerIds) {
        const player = await tx.player.findUnique({ where: { id: playerId } });
        if (player && player.deletedAt === null) {
          await tx.seasonTeamPlayer.deleteMany({
            where: { seasonId: effectiveSeasonId, teamId, playerId },
          });
          auditDiffs.push(`删除球员: ${player.name}`);
        }
      }
    }

    for (const playerDto of players) {
      const normalizedDto = {
        ...playerDto,
        name: (playerDto.name || '').trim(),
        studentId: (playerDto.studentId || '').trim(),
        jerseyNumber: (playerDto.jerseyNumber || '').trim(),
      };

      const existingById = normalizedDto.id
        ? await tx.player.findUnique({ where: { id: normalizedDto.id } })
        : null;
      if (normalizedDto.id && !existingById) {
        throw new BadRequestException(`未找到 ID 为 ${normalizedDto.id} 的球员记录`);
      }

      if (!isSuperAdmin) {
        const conflictingStudent = await tx.seasonTeamPlayer.findFirst({
          where: {
            seasonId: effectiveSeasonId,
            playerId: existingById ? { not: existingById.id } : undefined,
            studentId: normalizedDto.studentId,
            player: { deletedAt: null },
          },
        });
        if (conflictingStudent) {
          throw new ConflictException(`学号 ${normalizedDto.studentId} 已被其他在籍球员使用`);
        }
      }

      let existingPlayer = existingById;
      if (!existingPlayer && normalizedDto.studentId && !isSuperAdmin) {
        existingPlayer = await tx.player.findFirst({
          where: { studentId: normalizedDto.studentId, deletedAt: null },
        });
      }

      let playerId: string;
      if (existingPlayer) {
        playerId = existingPlayer.id;
        await tx.player.update({
          where: { id: playerId },
          data: {
            name: normalizedDto.name || existingPlayer.name,
            jerseyNumber: normalizedDto.jerseyNumber || existingPlayer.jerseyNumber,
            photo: normalizedDto.photo !== undefined ? normalizedDto.photo : existingPlayer.photo,
            teamId,
          },
        });
      } else {
        const newPlayer = await tx.player.create({
          data: {
            name: normalizedDto.name || '未命名球员',
            studentId:
              normalizedDto.studentId ||
              `S_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            jerseyNumber: normalizedDto.jerseyNumber || '0',
            photo: normalizedDto.photo || null,
            teamId,
          },
        });
        playerId = newPlayer.id;
      }

      await tx.seasonTeamPlayer.upsert({
        where: { seasonId_playerId: { seasonId: effectiveSeasonId, playerId } },
        create: {
          seasonId: effectiveSeasonId,
          teamId,
          playerId,
          playerName: normalizedDto.name || '未命名球员',
          studentId: normalizedDto.studentId || '',
          jerseyNumber: normalizedDto.jerseyNumber || '0',
          playerPhoto: normalizedDto.photo || null,
        },
        update: {
          teamId,
          playerName: normalizedDto.name || '未命名球员',
          studentId: normalizedDto.studentId || '',
          jerseyNumber: normalizedDto.jerseyNumber || '0',
          playerPhoto: normalizedDto.photo || null,
        },
      });
    }

    return updatedTeam;
  }

  async updateWithPlayers(
    teamId: string,
    dto: UpdateTeamWithPlayersDto,
    username: string = 'admin',
    userCtx?: { role?: string; teamId?: string },
    txParam?: any,
  ) {
    if (userCtx?.role === 'coach' && userCtx.teamId !== teamId) {
      throw new ForbiddenException('您没有权限修改其他球队的信息');
    }
    if (txParam) {
      return this.updateWithPlayersCore(txParam, teamId, dto, username, userCtx);
    }
    const result = await this.prisma.$transaction(
      async (tx) => this.updateWithPlayersCore(tx, teamId, dto, username, userCtx),
      { timeout: 30000 },
    );
    await this.afterTeamCommitted(result.id, username);
    return result;
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
    const cacheErrors: string[] = [];
    const seasons = await this.prisma.season.findMany();
    for (const season of seasons) {
      const result = await this.seasonStatistics.computeAndCache(season.id);
      if (!result.success) {
        cacheErrors.push(`赛季 ${season.name}: ${result.error}`);
      }
    }
    if (cacheErrors.length > 0) {
      console.error('更新球队队徽后重建积分榜统计缓存部分失败:', cacheErrors);
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
    if (
      updateTeamDto.homeJerseyColor !== undefined &&
      updateTeamDto.homeJerseyColor !== team.homeJerseyColor
    ) {
      diffs.push(
        `主场球衣: ${team.homeJerseyColor || '无'}->${updateTeamDto.homeJerseyColor || '无'}`,
      );
    }
    if (
      updateTeamDto.awayJerseyColor !== undefined &&
      updateTeamDto.awayJerseyColor !== team.awayJerseyColor
    ) {
      diffs.push(
        `客场球衣: ${team.awayJerseyColor || '无'}->${updateTeamDto.awayJerseyColor || '无'}`,
      );
    }

    const details =
      diffs.length > 0
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
      where: { teamId: id, deletedAt: null },
    });

    const deletedTeam = await this.prisma.$transaction(async (tx) => {
      for (const player of teamPlayers) {
        await tx.player.update({
          where: { id: player.id },
          data: {
            deletedAt: new Date(),
            studentId: `${player.studentId}_deleted_${timestamp}`,
          },
        });
      }

      // 2. 软删除该球队并释放唯一队名约束
      return tx.team.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          teamName: `${team.teamName}_deleted_${timestamp}`,
        },
      });
    });

    await this.auditLogService.log(
      username,
      'DELETE_TEAM',
      `删除球队: "${team.teamName}" (级联删除球员 ${teamPlayers.length} 人)`,
    );

    return deletedTeam;
  }
}
