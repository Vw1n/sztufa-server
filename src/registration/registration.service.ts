import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TeamRosterService } from '../team/team-roster.service';
import { CreateRegistrationDto } from './dto/create-registration.dto';
import { SaveRegistrationDto } from './dto/save-registration.dto';
import { ReviewRegistrationDto } from './dto/review-registration.dto';
import { RegistrationListQueryDto } from './dto/registration-list-query.dto';

export interface UserContext {
  id: string;
  username: string;
  role: string;
  teamId?: string | null;
}

@Injectable()
export class RegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly teamRosterService: TeamRosterService,
  ) {}

  private checkCoachTeamBinding(userCtx: UserContext): string {
    if (userCtx.role !== 'coach' || !userCtx.teamId) {
      throw new ForbiddenException('仅绑定球队的领队账号可执行此操作');
    }
    return userCtx.teamId;
  }

  private checkRegistrationOwnership(registration: { teamId: string }, userCtx: UserContext) {
    if (userCtx.role === 'coach' && registration.teamId !== userCtx.teamId) {
      throw new ForbiddenException('无权查看或修改操作其他球队的报名');
    }
  }

  private validateImageUrl(url?: string | null, fieldName = '图片'): string | null {
    if (!url) return null;
    const trimmed = url.trim();
    if (trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
      throw new BadRequestException(`${fieldName}地址无效，禁止保存本地 blob: 或 base64 数据`);
    }
    return trimmed;
  }

  async getMine(seasonId?: string, userCtx?: UserContext) {
    if (!userCtx) throw new ForbiddenException('未身份验证');
    const teamId = this.checkCoachTeamBinding(userCtx);

    let targetSeasonId = seasonId;
    if (!targetSeasonId) {
      const activeSeason = await this.prisma.season.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
      if (!activeSeason) {
        throw new NotFoundException('系统当前无活跃赛季');
      }
      targetSeasonId = activeSeason.id;
    }

    const registration = await this.prisma.teamRegistration.findUnique({
      where: {
        seasonId_teamId: {
          seasonId: targetSeasonId,
          teamId,
        },
      },
      include: {
        teamData: true,
        players: {
          orderBy: { createdAt: 'asc' },
        },
        season: {
          select: { id: true, name: true, status: true },
        },
        team: {
          select: { id: true, teamName: true, gender: true },
        },
      },
    });

    return registration;
  }

  async create(dto: CreateRegistrationDto, userCtx: UserContext) {
    const teamId = this.checkCoachTeamBinding(userCtx);

    const season = await this.prisma.season.findUnique({
      where: { id: dto.seasonId },
    });
    if (!season || season.status !== 'active') {
      throw new BadRequestException('所选赛季不存在或非活跃赛季');
    }

    const existing = await this.prisma.teamRegistration.findUnique({
      where: {
        seasonId_teamId: {
          seasonId: dto.seasonId,
          teamId,
        },
      },
      include: {
        teamData: true,
        players: { orderBy: { createdAt: 'asc' } },
        season: { select: { id: true, name: true, status: true } },
        team: { select: { id: true, teamName: true, gender: true } },
      },
    });

    if (existing) {
      return existing;
    }

    const officialTeam = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        players: {
          where: { deletedAt: null },
        },
      },
    });

    if (!officialTeam || officialTeam.deletedAt !== null) {
      throw new NotFoundException('绑定的球队不存在或已被删除');
    }

    return this.prisma.teamRegistration.create({
      data: {
        seasonId: dto.seasonId,
        teamId,
        submittedById: userCtx.id,
        status: RegistrationStatus.DRAFT,
        teamData: {
          create: {
            teamName: officialTeam.teamName,
            teamDoctor: officialTeam.teamDoctor,
            headCoach: officialTeam.headCoach,
            teamLeader: officialTeam.teamLeader,
            coachPhone: officialTeam.coachPhone,
            leaderPhone: officialTeam.leaderPhone,
            homeJerseyColor: officialTeam.homeJerseyColor,
            awayJerseyColor: officialTeam.awayJerseyColor,
            teamLogo: this.validateImageUrl(officialTeam.teamLogo, '球队 Logo'),
            homeJersey: this.validateImageUrl(officialTeam.homeJersey, '主场球衣'),
            awayJersey: this.validateImageUrl(officialTeam.awayJersey, '客场球衣'),
            gender: officialTeam.gender || 'MALE',
          },
        },
        players: {
          create: officialTeam.players.map((p) => ({
            playerId: p.id,
            name: p.name,
            studentId: p.studentId,
            jerseyNumber: p.jerseyNumber,
            photo: this.validateImageUrl(p.photo, `球员 [${p.name}] 照片`),
          })),
        },
      },
      include: {
        teamData: true,
        players: { orderBy: { createdAt: 'asc' } },
        season: { select: { id: true, name: true, status: true } },
        team: { select: { id: true, teamName: true, gender: true } },
      },
    });
  }

  async save(id: string, saveDto: SaveRegistrationDto, userCtx: UserContext) {
    const teamId = this.checkCoachTeamBinding(userCtx);
    const { teamData, players } = saveDto;

    return this.prisma.$transaction(async (tx) => {
      // 1. 在事务内原子条件更新，锁定并确认当前状态处于可编辑集合中 [DRAFT, CHANGES_REQUESTED]
      const lockResult = await tx.teamRegistration.updateMany({
        where: {
          id,
          teamId,
          status: { in: [RegistrationStatus.DRAFT, RegistrationStatus.CHANGES_REQUESTED] },
        },
        data: {
          updatedAt: new Date(),
        },
      });

      if (lockResult.count !== 1) {
        const existing = await tx.teamRegistration.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException('报名记录不存在');
        }
        this.checkRegistrationOwnership(existing, userCtx);
        throw new ConflictException('已提交或已通过审核的报名不可编辑修改');
      }

      const registration = await tx.teamRegistration.findUnique({
        where: { id },
        include: { teamData: true },
      });

      if (!registration) {
        throw new NotFoundException('报名记录不存在');
      }

      if (teamData) {
        const updateData: Prisma.RegistrationTeamDataUpdateInput = {};
        if (teamData.teamName !== undefined) updateData.teamName = teamData.teamName.trim();
        if (teamData.teamDoctor !== undefined)
          updateData.teamDoctor = teamData.teamDoctor?.trim() || null;
        if (teamData.headCoach !== undefined)
          updateData.headCoach = teamData.headCoach?.trim() || null;
        if (teamData.teamLeader !== undefined)
          updateData.teamLeader = teamData.teamLeader?.trim() || null;
        if (teamData.coachPhone !== undefined)
          updateData.coachPhone = teamData.coachPhone?.trim() || null;
        if (teamData.leaderPhone !== undefined)
          updateData.leaderPhone = teamData.leaderPhone?.trim() || null;
        if (teamData.homeJerseyColor !== undefined)
          updateData.homeJerseyColor = teamData.homeJerseyColor.trim();
        if (teamData.awayJerseyColor !== undefined)
          updateData.awayJerseyColor = teamData.awayJerseyColor.trim();
        if (teamData.teamLogo !== undefined)
          updateData.teamLogo = this.validateImageUrl(teamData.teamLogo, '球队 Logo');
        if (teamData.homeJersey !== undefined)
          updateData.homeJersey = this.validateImageUrl(teamData.homeJersey, '主场球衣');
        if (teamData.awayJersey !== undefined)
          updateData.awayJersey = this.validateImageUrl(teamData.awayJersey, '客场球衣');
        if (teamData.gender !== undefined) updateData.gender = teamData.gender;

        const createData: Prisma.RegistrationTeamDataCreateInput = {
          registration: { connect: { id } },
          teamName: (teamData.teamName || registration.teamData?.teamName || '').trim(),
          teamDoctor:
            (teamData.teamDoctor !== undefined
              ? teamData.teamDoctor
              : registration.teamData?.teamDoctor
            )?.trim() || null,
          headCoach:
            (teamData.headCoach !== undefined
              ? teamData.headCoach
              : registration.teamData?.headCoach
            )?.trim() || null,
          teamLeader:
            (teamData.teamLeader !== undefined
              ? teamData.teamLeader
              : registration.teamData?.teamLeader
            )?.trim() || null,
          coachPhone:
            (teamData.coachPhone !== undefined
              ? teamData.coachPhone
              : registration.teamData?.coachPhone
            )?.trim() || null,
          leaderPhone:
            (teamData.leaderPhone !== undefined
              ? teamData.leaderPhone
              : registration.teamData?.leaderPhone
            )?.trim() || null,
          homeJerseyColor: (
            teamData.homeJerseyColor ||
            registration.teamData?.homeJerseyColor ||
            ''
          ).trim(),
          awayJerseyColor: (
            teamData.awayJerseyColor ||
            registration.teamData?.awayJerseyColor ||
            ''
          ).trim(),
          teamLogo: this.validateImageUrl(
            teamData.teamLogo !== undefined ? teamData.teamLogo : registration.teamData?.teamLogo,
            '球队 Logo',
          ),
          homeJersey: this.validateImageUrl(
            teamData.homeJersey !== undefined
              ? teamData.homeJersey
              : registration.teamData?.homeJersey,
            '主场球衣',
          ),
          awayJersey: this.validateImageUrl(
            teamData.awayJersey !== undefined
              ? teamData.awayJersey
              : registration.teamData?.awayJersey,
            '客场球衣',
          ),
          gender: teamData.gender || registration.teamData?.gender || 'MALE',
        };

        await tx.registrationTeamData.upsert({
          where: { registrationId: id },
          create: createData,
          update: updateData,
        });
      }

      if (players) {
        for (const p of players) {
          if (p.photo) {
            this.validateImageUrl(p.photo, `球员 [${p.name || ''}] 照片`);
          }
        }

        await tx.registrationPlayer.deleteMany({
          where: { registrationId: id },
        });

        if (players.length > 0) {
          await tx.registrationPlayer.createMany({
            data: players.map((p) => ({
              registrationId: id,
              playerId: p.playerId || null,
              name: (p.name || '').trim(),
              studentId: (p.studentId || '').trim(),
              jerseyNumber: (p.jerseyNumber || '').trim(),
              photo: this.validateImageUrl(p.photo, `球员 [${p.name || ''}] 照片`),
            })),
          });
        }
      }

      return tx.teamRegistration.findUnique({
        where: { id },
        include: {
          teamData: true,
          players: { orderBy: { createdAt: 'asc' } },
          season: { select: { id: true, name: true, status: true } },
          team: { select: { id: true, teamName: true, gender: true } },
        },
      });
    });
  }

  async submit(id: string, userCtx: UserContext) {
    const teamId = this.checkCoachTeamBinding(userCtx);

    return this.prisma.$transaction(async (tx) => {
      // 1. 事务第一步：原子条件更新状态锁 [DRAFT, CHANGES_REQUESTED] -> SUBMITTED
      const submitResult = await tx.teamRegistration.updateMany({
        where: {
          id,
          teamId,
          status: { in: [RegistrationStatus.DRAFT, RegistrationStatus.CHANGES_REQUESTED] },
        },
        data: {
          status: RegistrationStatus.SUBMITTED,
          submittedAt: new Date(),
          reviewedAt: null,
          reviewedById: null,
        },
      });

      // 2. 若未成功取得状态锁，精确区分 404 (不存在)、403 (越权)、409 (状态冲突)
      if (submitResult.count !== 1) {
        const existing = await tx.teamRegistration.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException('报名记录不存在');
        }
        this.checkRegistrationOwnership(existing, userCtx);
        throw new ConflictException('当前状态不支持提交或已完成提交 (已被处理)');
      }

      // 3. 取得锁后，读取最新的球队资料与球员名单快照
      const registration = await tx.teamRegistration.findUnique({
        where: { id },
        include: {
          teamData: true,
          players: { orderBy: { createdAt: 'asc' } },
          season: { select: { id: true, name: true, status: true } },
          team: { select: { id: true, teamName: true, gender: true } },
        },
      });

      if (!registration || !registration.teamData || !registration.teamData.teamName) {
        throw new BadRequestException('提交失败：球队资料尚未完整填写');
      }

      if (!registration.players || registration.players.length === 0) {
        throw new BadRequestException('提交失败：请至少添加一名球员名单');
      }

      // 4. 校验全部通过，返回最新报名
      return registration;
    });
  }

  async getAdminList(queryDto: RegistrationListQueryDto) {
    const { seasonId, status, page = 1, pageSize = 20 } = queryDto;
    const skip = (page - 1) * pageSize;

    const where: Prisma.TeamRegistrationWhereInput = {};
    if (seasonId) where.seasonId = seasonId;
    if (status) where.status = status;

    const [total, items] = await Promise.all([
      this.prisma.teamRegistration.count({ where }),
      this.prisma.teamRegistration.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          seasonId: true,
          teamId: true,
          status: true,
          reviewComment: true,
          submittedAt: true,
          reviewedAt: true,
          updatedAt: true,
          teamData: {
            select: {
              teamName: true,
              gender: true,
              teamLogo: true,
            },
          },
          season: {
            select: { name: true },
          },
          team: {
            select: { teamName: true },
          },
          _count: {
            select: { players: true },
          },
        },
      }),
    ]);

    const formattedItems = items.map((item) => ({
      id: item.id,
      seasonId: item.seasonId,
      seasonName: item.season?.name || '',
      teamId: item.teamId,
      teamName: item.teamData?.teamName || item.team?.teamName || '',
      gender: item.teamData?.gender || 'MALE',
      teamLogo: item.teamData?.teamLogo || null,
      status: item.status,
      playerCount: item._count.players,
      reviewComment: item.reviewComment,
      submittedAt: item.submittedAt,
      reviewedAt: item.reviewedAt,
      updatedAt: item.updatedAt,
    }));

    return {
      items: formattedItems,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  async getDetail(id: string, userCtx: UserContext) {
    const registration = await this.prisma.teamRegistration.findUnique({
      where: { id },
      include: {
        teamData: true,
        players: { orderBy: { createdAt: 'asc' } },
        season: { select: { id: true, name: true, status: true } },
        team: { select: { id: true, teamName: true, gender: true } },
        submittedBy: { select: { id: true, username: true, nickname: true } },
        reviewedBy: { select: { id: true, username: true, nickname: true } },
      },
    });

    if (!registration) {
      throw new NotFoundException('报名记录不存在');
    }

    this.checkRegistrationOwnership(registration, userCtx);

    return registration;
  }

  async requestChanges(id: string, reviewDto: ReviewRegistrationDto, userCtx: UserContext) {
    if (userCtx.role !== 'super_admin') {
      throw new ForbiddenException('仅超级管理员可审核退回报名');
    }

    return this.prisma.$transaction(async (tx) => {
      const updateResult = await tx.teamRegistration.updateMany({
        where: {
          id,
          status: RegistrationStatus.SUBMITTED,
        },
        data: {
          status: RegistrationStatus.CHANGES_REQUESTED,
          reviewComment: reviewDto.reviewComment?.trim() || null,
          reviewedAt: new Date(),
          reviewedById: userCtx.id,
        },
      });

      if (updateResult.count !== 1) {
        throw new ConflictException('报名记录不存在或当前状态非待审核 (已被其他管理员审批或退回)');
      }

      const registration = await tx.teamRegistration.findUnique({
        where: { id },
        include: {
          teamData: true,
          players: { orderBy: { createdAt: 'asc' } },
          season: { select: { id: true, name: true, status: true } },
          team: { select: { id: true, teamName: true, gender: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          username: userCtx.username,
          action: 'REGISTRATION_REQUEST_CHANGES',
          details: `退回球队 "${registration?.teamData?.teamName || registration?.teamId}" 的赛季报名申请 (意见: ${reviewDto.reviewComment || '无'})`,
        },
      });

      return registration;
    });
  }

  async approve(id: string, reviewDto: ReviewRegistrationDto, userCtx: UserContext) {
    if (userCtx.role !== 'super_admin') {
      throw new ForbiddenException('仅超级管理员可审批通过报名');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. 原子化条件更新：状态必须为 SUBMITTED
      const updateResult = await tx.teamRegistration.updateMany({
        where: {
          id,
          status: RegistrationStatus.SUBMITTED,
        },
        data: {
          status: RegistrationStatus.APPROVED,
          reviewComment: reviewDto.reviewComment?.trim() || null,
          reviewedAt: new Date(),
          reviewedById: userCtx.id,
        },
      });

      if (updateResult.count !== 1) {
        throw new ConflictException('报名记录不存在或当前状态非待审核 (已被其他管理员审批或撤回)');
      }

      // 2. 读取完整的报名数据
      const registration = await tx.teamRegistration.findUnique({
        where: { id },
        include: {
          teamData: true,
          players: true,
        },
      });

      if (!registration || !registration.teamData) {
        throw new NotFoundException('报名或球队资料不存在');
      }

      const { seasonId, teamId, teamData, players } = registration;

      // 3. 物化 SeasonTeamProfile 记录
      await tx.seasonTeamProfile.upsert({
        where: { seasonId_teamId: { seasonId, teamId } },
        create: {
          seasonId,
          teamId,
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
          gender: teamData.gender,
          isRegistered: true,
        },
        update: {
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
          gender: teamData.gender,
          isRegistered: true,
        },
      });

      // 4. 解析与匹配 Player，物化 SeasonTeamPlayer
      const materializedRoster: Array<{
        id: string;
        name: string;
        studentId: string;
        jerseyNumber: string;
        photo: string | null;
      }> = [];

      for (const regPlayer of players) {
        let resolvedPlayerId: string | null = null;

        // 步骤 4a: 如果提供了 playerId，验证其合法性（必须属于该球队且未删除）
        if (regPlayer.playerId) {
          const existingPlayer = await tx.player.findFirst({
            where: {
              id: regPlayer.playerId,
              teamId,
              deletedAt: null,
            },
          });
          if (existingPlayer) {
            resolvedPlayerId = existingPlayer.id;
            // 更新球员基本资料
            await tx.player.update({
              where: { id: resolvedPlayerId },
              data: {
                name: regPlayer.name,
                studentId: regPlayer.studentId,
                jerseyNumber: regPlayer.jerseyNumber,
                photo: regPlayer.photo,
              },
            });
          }
        }

        // 步骤 4b: 如果未通过 playerId 解析成功，按 (teamId + studentId + deletedAt: null) 精准匹配
        if (!resolvedPlayerId) {
          const existingByStudentId = await tx.player.findFirst({
            where: {
              teamId,
              studentId: regPlayer.studentId,
              deletedAt: null,
            },
          });

          if (existingByStudentId) {
            resolvedPlayerId = existingByStudentId.id;
            await tx.player.update({
              where: { id: resolvedPlayerId },
              data: {
                name: regPlayer.name,
                jerseyNumber: regPlayer.jerseyNumber,
                photo: regPlayer.photo,
              },
            });
          }
        }

        // 步骤 4c: 仍未找到则新建正式 Player 记录
        if (!resolvedPlayerId) {
          const newPlayer = await tx.player.create({
            data: {
              teamId,
              name: regPlayer.name,
              studentId: regPlayer.studentId,
              jerseyNumber: regPlayer.jerseyNumber,
              photo: regPlayer.photo,
            },
          });
          resolvedPlayerId = newPlayer.id;
        }

        materializedRoster.push({
          id: resolvedPlayerId,
          name: regPlayer.name,
          studentId: regPlayer.studentId,
          jerseyNumber: regPlayer.jerseyNumber,
          photo: regPlayer.photo,
        });
      }

      // 5. 替换 SeasonTeamPlayer 关联
      await tx.seasonTeamPlayer.deleteMany({
        where: { seasonId, teamId },
      });

      for (const playerItem of materializedRoster) {
        await this.teamRosterService.registerPlayer(tx, seasonId, teamId, playerItem);
      }

      // 6. 审计日志
      await tx.auditLog.create({
        data: {
          username: userCtx.username,
          action: 'REGISTRATION_APPROVE',
          details: `通过球队 "${teamData.teamName}" 的赛季报名申请 (包含球员 ${materializedRoster.length} 名)`,
        },
      });

      return tx.teamRegistration.findUnique({
        where: { id },
        include: {
          teamData: true,
          players: { orderBy: { createdAt: 'asc' } },
          season: { select: { id: true, name: true, status: true } },
          team: { select: { id: true, teamName: true, gender: true } },
          reviewedBy: { select: { id: true, username: true, nickname: true } },
        },
      });
    });
  }
}
