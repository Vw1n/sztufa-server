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

    await this.auditLogService.log(username, 'CREATE_TEAM', `创建球队: "${team.teamName}"`);

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

    return this.prisma.$transaction(
      async (tx) => {
        const targetSeason = await this.teamRosterService.validateTargetSeason(
          tx,
          seasonId,
          teamData.gender || 'MALE',
        );

        // A Team is shared across seasons. If the same team existed in an
        // older season, reuse it and register the submitted roster in the
        // selected season. Only duplicate participation in that season is a
        // conflict.
        const existingTeam = await tx.team.findFirst({
          where: { teamName: teamData.teamName },
        });
        if (existingTeam) {
          const alreadyInTargetSeason = await tx.team.findFirst({
            where: {
              id: existingTeam.id,
              OR: [
                { seasonPlayers: { some: { seasonId } } },
                { seasonProfiles: { some: { seasonId } } },
                { groupTeams: { some: { seasonId } } },
                { homeMatches: { some: { seasonId } } },
                { awayMatches: { some: { seasonId } } },
              ],
            },
            select: { id: true },
          });
          if (alreadyInTargetSeason) {
            throw new ConflictException('该球队已存在于所选赛季中');
          }
        }

        const team = existingTeam
          ? await tx.team.update({
              where: { id: existingTeam.id },
              data: { ...teamData, deletedAt: null },
            })
          : await tx.team.create({ data: teamData });

        await tx.seasonTeamProfile.create({
          data: {
            seasonId: targetSeason.id,
            teamId: team.id,
            teamName: teamData.teamName,
            teamDoctor: teamData.teamDoctor,
            headCoach: teamData.headCoach,
            teamLeader: teamData.teamLeader,
            coachPhone: teamData.coachPhone,
            leaderPhone: teamData.leaderPhone,
            homeJerseyColor: teamData.homeJerseyColor,
            awayJerseyColor: teamData.awayJerseyColor,
            teamLogo: teamData.teamLogo,
            homeJersey: teamData.homeJersey,
            awayJersey: teamData.awayJersey,
            gender: teamData.gender || 'MALE',
          },
        });

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

          await this.teamRosterService.registerPlayer(tx, targetSeason.id, team.id, savedPlayer);
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
      },
      { timeout: 30000 },
    );
  }

  async updateWithPlayers(
    teamId: string,
    dto: UpdateTeamWithPlayersDto,
    username: string = 'admin',
    userCtx?: { role?: string; teamId?: string },
  ) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team || team.deletedAt !== null) {
      throw new NotFoundException('球队不存在');
    }
    if (userCtx?.role === 'coach' && userCtx.teamId !== teamId) {
      throw new ForbiddenException('您没有权限修改其他球队的信息');
    }

    // 校验球队名称唯一性
    if (dto.teamName && dto.teamName !== team.teamName) {
      const existing = await this.prisma.team.findFirst({
        where: { teamName: dto.teamName, deletedAt: null },
      });
      if (existing) {
        throw new ConflictException('该球队名称已存在，请使用其他名称');
      }
    }

    const { players = [], deletePlayerIds = [], seasonId, ...teamData } = dto;

    // 校验球员数据
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

    // 查找当前活跃赛季，用于名册同步
    const targetSeason = await this.prisma.season.findUnique({ where: { id: seasonId } });
    if (!targetSeason) {
      throw new NotFoundException('所选赛季不存在');
    }

    return this.prisma.$transaction(
      async (tx) => {
        // 1. 更新球队基本信息
        // Team is only the stable identity. Editable presentation data belongs
        // to one season and must never be propagated to another season.
        const profileData = { ...team, ...teamData };
        const updatedProfile = await tx.seasonTeamProfile.upsert({
          where: { seasonId_teamId: { seasonId, teamId } },
          create: {
            seasonId,
            teamId,
            teamName: profileData.teamName,
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
            gender: profileData.gender,
          },
          update: teamData,
        });
        const updatedTeam = { ...team, ...updatedProfile };

        // Remove stale roster entries when a team's gender changes.
        if (!isTeamGenderCompatibleWithSeason(targetSeason.name, updatedTeam.gender)) {
          await tx.seasonTeamPlayer.deleteMany({ where: { seasonId, teamId } });
        }

        const auditDiffs: string[] = [];

        // 2. 删除球员
        if (deletePlayerIds.length > 0) {
          for (const playerId of deletePlayerIds) {
            const player = await tx.player.findUnique({ where: { id: playerId } });
            if (player && player.teamId === teamId && player.deletedAt === null) {
              // Removing a player from a season must preserve their identity
              // and every roster snapshot belonging to other seasons.
              await tx.seasonTeamPlayer.deleteMany({ where: { seasonId, teamId, playerId } });
              auditDiffs.push(`删除球员: ${player.name}`);
            }
          }
        }

        // 3. 新增和更新球员
        for (const playerDto of players) {
          const normalizedDto = {
            ...playerDto,
            name: playerDto.name.trim(),
            studentId: playerDto.studentId.trim(),
            jerseyNumber: playerDto.jerseyNumber.trim(),
          };

          const existingById = normalizedDto.id
            ? await tx.player.findUnique({ where: { id: normalizedDto.id } })
            : null;
          if (normalizedDto.id && (!existingById || existingById.teamId !== teamId)) {
            throw new BadRequestException(`球员 ${normalizedDto.name} 不属于当前球队`);
          }

          const conflictingStudent = await tx.player.findFirst({
            where: {
              id: existingById ? { not: existingById.id } : undefined,
              deletedAt: null,
              studentId: normalizedDto.studentId,
            },
          });
          if (conflictingStudent) {
            throw new ConflictException(`学号 ${normalizedDto.studentId} 已被其他在籍球员使用`);
          }

          const restorableByStudentId = existingById
            ? null
            : await tx.player.findFirst({
                where: {
                  studentId: { startsWith: `${normalizedDto.studentId}_deleted_` },
                  deletedAt: { not: null },
                },
                orderBy: { createdAt: 'desc' },
              });
          const existingPlayer = existingById || restorableByStudentId;

          if (existingPlayer) {
            // 恢复或更新已有球员
            await tx.player.update({
              where: { id: existingPlayer.id },
              data: {
                name: normalizedDto.name,
                studentId: normalizedDto.studentId,
                jerseyNumber: normalizedDto.jerseyNumber,
                photo: normalizedDto.photo ?? existingPlayer.photo ?? null,
                status: normalizedDto.status || 'active',
                yellowCards: normalizedDto.yellowCards ?? existingPlayer.yellowCards,
                redCards: normalizedDto.redCards ?? existingPlayer.redCards,
                teamId: teamId,
                deletedAt: null,
              },
            });

            // 同步赛季名册
            if (isTeamGenderCompatibleWithSeason(targetSeason.name, updatedTeam.gender)) {
              await tx.seasonTeamPlayer.upsert({
                where: { seasonId_playerId: { seasonId, playerId: existingPlayer.id } },
                create: {
                  seasonId,
                  teamId,
                  playerId: existingPlayer.id,
                  playerName: normalizedDto.name,
                  jerseyNumber: normalizedDto.jerseyNumber,
                  playerPhoto: normalizedDto.photo ?? existingPlayer.photo ?? null,
                },
                update: {
                  teamId,
                  playerName: normalizedDto.name,
                  jerseyNumber: normalizedDto.jerseyNumber,
                  playerPhoto: normalizedDto.photo ?? existingPlayer.photo ?? null,
                },
              });
            }

            auditDiffs.push(
              existingPlayer.deletedAt
                ? `恢复球员: ${normalizedDto.name}`
                : `更新球员: ${normalizedDto.name}`,
            );
          } else {
            // 创建新球员
            const newPlayer = await tx.player.create({
              data: {
                name: normalizedDto.name,
                studentId: normalizedDto.studentId,
                jerseyNumber: normalizedDto.jerseyNumber,
                photo: normalizedDto.photo || null,
                status: normalizedDto.status || 'active',
                yellowCards: normalizedDto.yellowCards ?? 0,
                redCards: normalizedDto.redCards ?? 0,
                teamId,
              },
            });

            // 同步赛季名册
            if (isTeamGenderCompatibleWithSeason(targetSeason.name, updatedTeam.gender)) {
              await tx.seasonTeamPlayer.upsert({
                where: { seasonId_playerId: { seasonId, playerId: newPlayer.id } },
                create: {
                  seasonId,
                  teamId,
                  playerId: newPlayer.id,
                  playerName: newPlayer.name,
                  jerseyNumber: newPlayer.jerseyNumber,
                  playerPhoto: newPlayer.photo,
                },
                update: {
                  teamId,
                  playerName: newPlayer.name,
                  jerseyNumber: newPlayer.jerseyNumber,
                  playerPhoto: newPlayer.photo,
                },
              });
            }

            auditDiffs.push(`新增球员: ${normalizedDto.name}`);
          }
        }

        // 4. 写入审计日志
        const teamFieldDiffs: string[] = [];
        if (dto.teamName !== undefined && dto.teamName !== team.teamName) {
          teamFieldDiffs.push(`队名: ${team.teamName}->${dto.teamName}`);
        }
        if (dto.teamLogo !== undefined && dto.teamLogo !== team.teamLogo) {
          teamFieldDiffs.push(`更新队徽`);
        }
        if (dto.headCoach !== undefined && dto.headCoach !== team.headCoach) {
          teamFieldDiffs.push(`主教练: ${team.headCoach || '无'}->${dto.headCoach || '无'}`);
        }

        const allDiffs = [...teamFieldDiffs, ...auditDiffs];
        await tx.auditLog.create({
          data: {
            username,
            action: 'UPDATE_TEAM_WITH_PLAYERS',
            details:
              allDiffs.length > 0
                ? `批量更新球队 "${team.teamName}": ${allDiffs.join(', ')}`
                : `保存球队 "${team.teamName}" 信息(未改动)`,
          },
        });

        // 5. 返回更新后的球队和球员
        return tx.team.findUnique({
          where: { id: teamId },
          include: { players: { where: { deletedAt: null } } },
        });
      },
      { timeout: 30000 },
    );
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
