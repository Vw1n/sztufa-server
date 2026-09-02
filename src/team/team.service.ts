import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
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
import { TeamAssetPipelineService } from './team-asset-pipeline.service';

@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly teamRosterService: TeamRosterService,
    private readonly seasonStatistics: SeasonStatisticsService,
    private readonly assetPipeline: TeamAssetPipelineService,
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

    const prepared = await this.assetPipeline.prepareTeamAssets(createTeamDto, username, userCtx);
    let team: any;
    try {
      const {
        preallocatedTeamId,
        players: _unusedPlayers,
        seasonId: _unusedSeasonId,
        id: _unusedId,
        ...teamScalarData
      } = prepared.normalizedDto;

      team = await this.prisma.team.create({
        data: {
          id: preallocatedTeamId || undefined,
          teamName: teamScalarData.teamName || '',
          homeJerseyColor: teamScalarData.homeJerseyColor || '',
          awayJerseyColor: teamScalarData.awayJerseyColor || '',
          gender: teamScalarData.gender || 'MALE',
          teamDoctor: teamScalarData.teamDoctor || null,
          headCoach: teamScalarData.headCoach || null,
          teamLeader: teamScalarData.teamLeader || null,
          coachPhone: teamScalarData.coachPhone || null,
          leaderPhone: teamScalarData.leaderPhone || null,
          teamLogo: teamScalarData.teamLogo || null,
          homeJersey: teamScalarData.homeJersey || null,
          awayJersey: teamScalarData.awayJersey || null,
        },
        include: { players: { where: { deletedAt: null } } },
      });
    } catch (err) {
      await prepared.safeRollback();
      throw err;
    }

    await this.afterTeamCommitted(team.id, username);
    await this.assetPipeline.safePostCommit(prepared, username);

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
        id: (dto as any).preallocatedTeamId || undefined,
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
          id: (player as any).preallocatedPlayerId || undefined,
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
    const prepared = await this.assetPipeline.prepareTeamAssets(dto, username, userCtx);
    let result: any;
    try {
      result = await this.prisma.$transaction(
        async (innerTx) =>
          this.createTeamCore(innerTx, prepared.normalizedDto, username, userCtx),
        { timeout: 30000 },
      );
    } catch (err) {
      await prepared.safeRollback();
      throw err;
    }

    await this.afterTeamCommitted(result.id, username);
    await this.assetPipeline.safePostCommit(prepared, username, dto.seasonId);
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

    if (targetSeason?.status === 'active') {
      await tx.team.update({
        where: { id: teamId },
        data: {
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
        },
      });
    }

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
            id: (normalizedDto as any).preallocatedPlayerId || undefined,
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

      const playerPhotoForCreate =
        normalizedDto.photo !== undefined
          ? normalizedDto.photo
          : existingPlayer?.photo || null;

      const playerPhotoForUpdate =
        normalizedDto.photo !== undefined ? normalizedDto.photo : undefined;

      await tx.seasonTeamPlayer.upsert({
        where: { seasonId_playerId: { seasonId: effectiveSeasonId, playerId } },
        create: {
          seasonId: effectiveSeasonId,
          teamId,
          playerId,
          playerName: normalizedDto.name || (existingPlayer ? existingPlayer.name : '未命名球员'),
          studentId: normalizedDto.studentId || (existingPlayer ? existingPlayer.studentId : ''),
          jerseyNumber:
            normalizedDto.jerseyNumber || (existingPlayer ? existingPlayer.jerseyNumber : '0'),
          playerPhoto: playerPhotoForCreate,
        },
        update: {
          teamId,
          playerName: normalizedDto.name || undefined,
          studentId: normalizedDto.studentId || undefined,
          jerseyNumber: normalizedDto.jerseyNumber || undefined,
          ...(playerPhotoForUpdate !== undefined ? { playerPhoto: playerPhotoForUpdate } : {}),
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
    const prepared = await this.assetPipeline.prepareTeamAssets(dto, username, userCtx, teamId);
    let result: any;
    try {
      result = await this.prisma.$transaction(
        async (tx) =>
          this.updateWithPlayersCore(tx, teamId, prepared.normalizedDto, username, userCtx),
        { timeout: 30000 },
      );
    } catch (err) {
      await prepared.safeRollback();
      throw err;
    }

    await this.afterTeamCommitted(result.id, username);
    await this.assetPipeline.safePostCommit(prepared, username, dto.seasonId);
    return result;
  }

  async update(
    id: string,
    updateTeamDto: UpdateTeamDto,
    username: string = 'admin',
    userCtx?: { role?: string },
  ) {
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

    const prepared = await this.assetPipeline.prepareTeamAssets(updateTeamDto, username, userCtx, id);
    let updatedTeam: any;
    try {
      const {
        preallocatedTeamId: _pId,
        players: _unusedPlayers,
        seasonId: _unusedSeasonId,
        id: _unusedId,
        deletePlayerIds: _del,
        ...teamScalarData
      } = prepared.normalizedDto;

      updatedTeam = await this.prisma.team.update({
        where: { id },
        data: teamScalarData,
        include: { players: { where: { deletedAt: null } } },
      });
    } catch (err) {
      await prepared.safeRollback();
      throw err;
    }

    // Post-commit 副作用隔离：审计日志、赛季统计缓存重算与临时对象清理失败绝不影响已提交的业务响应
    try {
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
    } catch (auditErr) {
      this.logger.error(
        `[update] 记录审计日志失败: ${auditErr}`,
        auditErr instanceof Error ? auditErr.stack : String(auditErr),
      );
    }

    try {
      const seasons = await this.prisma.season.findMany();
      for (const season of seasons) {
        try {
          const result = await this.seasonStatistics.computeAndCache(season.id);
          if (!result.success) {
            this.logger.warn(`[update] 赛季 ${season.name} 缓存重建未完全成功: ${result.error}`);
          }
        } catch (seasonErr) {
          this.logger.error(
            `[update] 赛季 ${season.name} 缓存重建异常: ${seasonErr}`,
            seasonErr instanceof Error ? seasonErr.stack : String(seasonErr),
          );
        }
      }
    } catch (seasonsErr) {
      this.logger.error(
        `[update] 获取赛季列表重建缓存异常: ${seasonsErr}`,
        seasonsErr instanceof Error ? seasonsErr.stack : String(seasonsErr),
      );
    }

    await this.assetPipeline.safePostCommit(prepared, username);

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
