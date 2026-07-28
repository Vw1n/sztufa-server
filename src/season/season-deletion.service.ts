import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class SeasonDeletionService {
  public static readonly REQUIRED_DELETION_APPROVALS = 1;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async approveSeasonDeletion(id: string, approverId: string | undefined, username: string) {
    if (!approverId) {
      throw new BadRequestException('无法识别审批人，请重新登录');
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        const approver = await tx.user.findUnique({
          where: { id: approverId },
          select: { id: true, username: true, role: true },
        });
        if (!approver || approver.role !== 'super_admin') {
          throw new BadRequestException('只有超级管理员可以审批删除赛季');
        }

        const season = await tx.season.findUnique({
          where: { id },
          select: {
            id: true,
            name: true,
            _count: {
              select: {
                matches: true,
                teamPlayers: true,
                groupTeams: true,
              },
            },
          },
        });
        if (!season) {
          throw new BadRequestException('赛季不存在');
        }

        await tx.seasonDeletionApproval.upsert({
          where: { seasonId_approverId: { seasonId: id, approverId } },
          update: {},
          create: { seasonId: id, approverId },
        });

        const approvals = await tx.seasonDeletionApproval.findMany({
          where: { seasonId: id },
          select: {
            createdAt: true,
            approver: { select: { id: true, username: true, role: true } },
          },
          orderBy: { createdAt: 'asc' },
        });
        const validApprovals = approvals.filter(
          (approval) => approval.approver.role === 'super_admin',
        );

        if (validApprovals.length < SeasonDeletionService.REQUIRED_DELETION_APPROVALS) {
          return {
            success: true,
            pending: true,
            approval: {
              approvedCount: validApprovals.length,
              requiredCount: SeasonDeletionService.REQUIRED_DELETION_APPROVALS,
              approvers: validApprovals.map((approval) => ({
                id: approval.approver.id,
                username: approval.approver.username,
                approvedAt: approval.createdAt,
              })),
            },
          };
        }

        await tx.match.deleteMany({ where: { seasonId: id } });
        await tx.season.delete({ where: { id } });

        return {
          success: true,
          pending: false,
          deleted: {
            id: season.id,
            name: season.name,
            matches: season._count.matches,
            teamPlayers: season._count.teamPlayers,
            groupTeams: season._count.groupTeams,
          },
          approvers: validApprovals
            .slice(0, SeasonDeletionService.REQUIRED_DELETION_APPROVALS)
            .map((approval) => approval.approver.username),
        };
      },
      { isolationLevel: 'Serializable' },
    );

    if (result.pending) {
      await this.auditLogService.log(
        username,
        'APPROVE_DELETE_SEASON',
        `审批删除赛季 ${id}（${result.approval?.approvedCount}/${result.approval?.requiredCount}）`,
      );
    } else {
      await this.auditLogService.log(
        username,
        'DELETE_SEASON',
        `超级管理员确认删除赛季 "${result.deleted?.name}"，同时删除 ${result.deleted?.matches} 场比赛、${result.deleted?.teamPlayers} 条赛季名单和 ${result.deleted?.groupTeams} 条分组记录`,
      );
    }

    return result;
  }
}
