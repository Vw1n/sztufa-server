import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { Prisma, MemberAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from '../auth/password';
import { CardStoreService } from './card-store.service';
import { reserveCardCapacity } from '../common/card-capacity';
import { loginLimitPrefix } from '../common/rolling-login-limit';
import { CardSubmissionDto, MemberListDto, MemberRegisterDto, ReviewCardDto } from './member.dto';

const profileFields = {
  id: true,
  username: true,
  nickname: true,
  studentId: true,
  verificationStatus: true,
  verificationVersion: true,
  reviewComment: true,
  disabled: true,
} as const;
const mask = (value?: string | null) =>
  value ? `${value.slice(0, 2)}****${value.slice(-2)}` : null;

@Injectable()
export class MemberService {
  private readonly logger = new Logger(MemberService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly store: CardStoreService,
  ) {}

  private async session(member: MemberAccount) {
    const user = await this.prisma.memberAccount.findUniqueOrThrow({
      where: { id: member.id },
      select: profileFields,
    });
    return {
      user: { ...user, role: 'user', accountType: 'member' },
      token: this.jwt.sign(
        { userId: member.id, accountType: 'member', sessionVersion: member.sessionVersion },
        {
          secret:
            this.config.get<string>('MEMBER_JWT_SECRET') ||
            this.config.get<string>('JWT_SECRET', 'local-development-secret-change-me'),
          audience: 'member',
          expiresIn: '30m',
          algorithm: 'HS256',
        },
      ),
    };
  }
  async validate(payload: any) {
    if (
      payload.accountType !== 'member' ||
      payload.aud !== 'member' ||
      typeof payload.userId !== 'string'
    )
      return null;
    const member = await this.prisma.memberAccount.findUnique({ where: { id: payload.userId } });
    if (!member || member.disabled || member.sessionVersion !== payload.sessionVersion) return null;
    const user = await this.prisma.memberAccount.findUnique({
      where: { id: member.id },
      select: profileFields,
    });
    return user ? { ...user, role: 'user', accountType: 'member' } : null;
  }
  async login(username: string, password: string) {
    const member = await this.prisma.memberAccount.findUnique({
      where: { username: username.trim() },
    });
    if (!member || member.disabled || !(await verifyPassword(password, member.password)))
      throw new UnauthorizedException('用户名或密码错误，或账号不可用');
    return this.session(member);
  }
  async logout(id: string) {
    await this.prisma.memberAccount.update({
      where: { id },
      data: { sessionVersion: { increment: 1 } },
    });
    return { success: true };
  }
  private async stage(file?: Express.Multer.File) {
    // 1. 先进行 Sharp 解码与文件基本校验（受 sharpLimiter 并发保护）
    const body = await this.store.normalize(file);

    // 2. 数据库事务原子检查容量与创建 STAGING 预占账本 (Serializable 隔离级别)
    const MAX_UNRELEASED_ASSETS = 500;
    const objectKey = `campus-cards/${randomUUID()}.webp`;

    const asset = await reserveCardCapacity(() => this.prisma.$transaction(
      async (tx) => {
        const unreleasedCount = await tx.campusCardAsset.count({
          where: {
            state: { not: 'DELETED' },
          },
        });

        if (unreleasedCount >= MAX_UNRELEASED_ASSETS) {
          throw new ServiceUnavailableException(
            '系统材料暂存容量已满，正在执行自动清理，请稍后再试',
          );
        }

        return tx.campusCardAsset.create({
          data: {
            objectKey,
            state: 'STAGING',
            uploadSettled: false,
            deleteAfter: new Date(Date.now() + 86400_000),
            leaseUntil: new Date(Date.now() + 60_000),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ));

    let writeStarted = false;
    try {
      // 3. 检查租约是否仍然有效
      const createdAtMs = asset?.createdAt
        ? new Date(asset.createdAt).getTime()
        : Date.now();
      if (Date.now() > createdAtMs + 60_000) {
        throw new ServiceUnavailableException(
          '上传处理超时，预占额度已过期，请重新提交',
        );
      }

      // 4. 写入 S3 存储
      writeStarted = true;
      await this.store.put(asset.objectKey, body);

      // 必须先持久化写入完成，再允许清理释放配额。若进程在此之前崩溃，
      // uploadSettled=false 的记录会一直保留，不能靠一次 HEAD 404 推断写入结束。
      await this.prisma.campusCardAsset.updateMany({
        where: { id: asset.id },
        data: { uploadSettled: true },
      });

      // 5. 上传完成后原子校验并续期租约（保证在上传期间未被 cleanup 标记或占用）
      const confirmed = await this.prisma.campusCardAsset.updateMany({
        where: {
          id: asset.id,
          state: 'STAGING',
          leaseUntil: { gte: new Date() },
        },
        data: {
          leaseUntil: new Date(Date.now() + 60_000), // 续期 60s 供后续事务使用
        },
      });

      if (confirmed.count !== 1) {
        throw new ServiceUnavailableException(
          '上传处理超时，预占租约已失效，请重新提交',
        );
      }

      return asset;
    } catch (err) {
      // 网络错误并不证明 PUT 未生效。保留写入未决标记，交给持久化清理任务。
      if (asset?.id) {
        await this.prisma.campusCardAsset
          .updateMany({
            where: { id: asset.id, state: 'STAGING' },
            data: {
              state: 'DELETE_PENDING',
              deleteAfter: new Date(),
              nextAttemptAt: new Date(),
              leaseUntil: null,
              deletedAt: null,
              ...(!writeStarted ? { uploadSettled: true } : {}),
            },
          })
          .catch(() => this.logger.error(`校园卡上传失败状态持久化失败，保留暂存账本：${asset.id}`));
      }
      throw err;
    }
  }
  async register(dto: MemberRegisterDto, file?: Express.Multer.File) {
    const password = await hashPassword(dto.password);
    if (await this.prisma.memberAccount.findUnique({ where: { username: dto.username } }))
      throw new ConflictException('该用户名不可用');
    const asset = await this.stage(file);
    const member = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.memberAccount.create({
          data: {
            username: dto.username,
            password,
            nickname: dto.nickname?.trim() || dto.username,
            realName: dto.realName,
            requestedStudentId: dto.studentId,
          },
        });

        // 校验 STAGING 与有效租约，杜绝竞争
        const bound = await tx.campusCardAsset.updateMany({
          where: {
            id: asset.id,
            state: 'STAGING',
            leaseUntil: { gte: new Date() },
          },
          data: {
            memberId: created.id,
            state: 'READY',
            leaseUntil: null,
            version: 1,
            deleteAfter: new Date(Date.now() + 30 * 86400_000),
          },
        });

        if (bound.count !== 1) {
          throw new ConflictException('材料预占租约已失效，请重新上传');
        }

        await tx.auditLog.create({
          data: {
            username: created.id,
            action: 'MEMBER_REGISTER',
            details: `提交校园卡审核；材料说明版本 ${dto.consentVersion}`,
          },
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return this.session(member);
  }
  async resubmit(id: string, dto: CardSubmissionDto, file?: Express.Multer.File) {
    const member = await this.prisma.memberAccount.findUniqueOrThrow({ where: { id } });
    if (member.disabled || member.verificationStatus === 'APPROVED')
      throw new ForbiddenException('当前账号不能补交材料');
    const asset = await this.stage(file);
    const nextVersion = member.verificationVersion + 1;

    await this.prisma.$transaction(
      async (tx) => {
        const changed = await tx.memberAccount.updateMany({
          where: {
            id,
            disabled: false,
            verificationVersion: member.verificationVersion,
            verificationStatus: { not: 'APPROVED' },
          },
          data: {
            realName: dto.realName,
            requestedStudentId: dto.studentId,
            verificationStatus: 'PENDING',
            verificationVersion: nextVersion,
            reviewComment: null,
            reviewedAt: null,
            reviewedBy: null,
          },
        });
        if (changed.count !== 1) throw new ConflictException('申请已变化，请刷新后重试');

        await tx.campusCardAsset.updateMany({
          where: { memberId: id, state: { not: 'DELETED' } },
          data: {
            state: 'DELETE_PENDING',
            deleteAfter: new Date(),
            nextAttemptAt: new Date(),
          },
        });

        // 校验 STAGING 与有效租约，绑定新版本材料
        const bound = await tx.campusCardAsset.updateMany({
          where: {
            id: asset.id,
            state: 'STAGING',
            leaseUntil: { gte: new Date() },
          },
          data: {
            memberId: id,
            state: 'READY',
            leaseUntil: null,
            version: nextVersion,
            deleteAfter: new Date(Date.now() + 30 * 86400_000),
          },
        });

        if (bound.count !== 1) {
          throw new ConflictException('材料预占租约已失效，请重新上传');
        }

        await tx.auditLog.create({
          data: {
            username: id,
            action: 'MEMBER_RESUBMIT',
            details: `补交校园卡材料；版本 ${nextVersion}`,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { success: true };
  }
  async list(query: MemberListDto) {
    const where: Prisma.MemberAccountWhereInput = {
      ...(query.status ? { verificationStatus: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { username: { contains: query.search } },
              { requestedStudentId: { contains: query.search } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.memberAccount.count({ where }),
      this.prisma.memberAccount.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          ...profileFields,
          requestedStudentId: true,
          source: true,
          createdAt: true,
          reviewedAt: true,
        },
      }),
    ]);
    return {
      total,
      page: query.page,
      limit: query.limit,
      data: rows.map((row) => ({
        ...row,
        studentId: mask(row.studentId),
        requestedStudentId: mask(row.requestedStudentId),
      })),
    };
  }
  async detail(id: string, operator: string) {
    const member = await this.prisma.memberAccount.findUnique({
      where: { id },
      select: {
        ...profileFields,
        realName: true,
        requestedStudentId: true,
        reviewedAt: true,
        reviewedBy: true,
        createdAt: true,
      },
    });
    if (!member) throw new NotFoundException('用户不存在');
    await this.prisma.auditLog.create({
      data: {
        username: operator,
        action: 'VIEW_MEMBER_VERIFICATION',
        details: `查看核验资料 ${id}`,
      },
    });
    const assets = await this.prisma.campusCardAsset.findMany({
      where: { memberId: id },
      select: { id: true, state: true, version: true, deletedAt: true, deleteAfter: true },
    });
    return { ...member, assets };
  }
  async preview(id: string, assetId: string, operator: string) {
    const member = await this.prisma.memberAccount.findUnique({ where: { id } });
    const asset = await this.prisma.campusCardAsset.findFirst({
      where: { id: assetId, memberId: id, state: 'READY', deleteAfter: { gt: new Date() } },
    });
    if (
      !member ||
      member.verificationStatus !== 'PENDING' ||
      !asset ||
      asset.version !== member.verificationVersion
    )
      throw new NotFoundException('材料不可查看或已删除');
    const body = await this.store.read(asset.objectKey);
    // 读取期间审核可能通过，返回字节之前再次检查访问条件。
    const stillPending = await this.prisma.memberAccount.count({
      where: { id, verificationStatus: 'PENDING', verificationVersion: asset.version },
    });
    if (!stillPending) throw new NotFoundException('材料已停止提供预览');
    await this.prisma.auditLog.create({
      data: { username: operator, action: 'VIEW_CAMPUS_CARD', details: `查看材料 ${asset.id}` },
    });
    return body;
  }
  async review(id: string, dto: ReviewCardDto, operator: string, clientIp?: string) {
    const member = await this.prisma.memberAccount.findUniqueOrThrow({ where: { id } });
    if (member.verificationVersion !== dto.version)
      throw new ConflictException('审核版本冲突，请刷新后重试');
    if (dto.decision === 'CHANGES_REQUESTED' && !dto.reason?.trim())
      throw new BadRequestException('退回补充时必须填写原因说明');
    const ipSuffix = clientIp ? ` (来源 IP: ${clientIp})` : '';
    await this.prisma.$transaction(
      async (tx) => {
        if (dto.decision === 'APPROVED') {
          const asset = await tx.campusCardAsset.findFirst({
            where: {
              memberId: id,
              version: dto.version,
              state: 'READY',
              deleteAfter: { gt: new Date() },
            },
          });
          if (!asset) throw new ConflictException('没有有效校园卡材料，请用户重新上传');
          if (!member.requestedStudentId) throw new BadRequestException('缺少申请学号');
        }

        const updated = await tx.memberAccount.updateMany({
          where: {
            id,
            verificationStatus: 'PENDING',
            verificationVersion: dto.version,
            disabled: false,
          },
          data: {
            verificationStatus: dto.decision,
            reviewComment: dto.reason?.trim() || null,
            reviewedBy: operator,
            reviewedAt: new Date(),
            ...(dto.decision === 'APPROVED' ? { studentId: member.requestedStudentId } : {}),
          },
        });
        if (updated.count !== 1) throw new ConflictException('申请已被其他操作修改');

        if (dto.decision === 'APPROVED') {
          await tx.campusCardAsset.updateMany({
            where: { memberId: id, state: { not: 'DELETED' } },
            data: { state: 'DELETE_PENDING', deleteAfter: new Date(), nextAttemptAt: new Date() },
          });
        }
        await tx.auditLog.create({
          data: {
            username: operator,
            action: 'REVIEW_CAMPUS_CARD',
            details: `账号 ${id}；版本 ${dto.version}；结果 ${dto.decision}${ipSuffix}`,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    // 必须等待首次清理尝试，失败由已持久化任务继续处理，审核结果不回滚。
    if (dto.decision === 'APPROVED') await this.cleanup(id);
    return this.detail(id, operator);
  }
  async setDisabled(id: string, disabled: boolean, operator: string, clientIp?: string) {
    const ipSuffix = clientIp ? ` (来源 IP: ${clientIp})` : '';
    await this.prisma.$transaction([
      this.prisma.memberAccount.update({
        where: { id },
        data: { disabled, sessionVersion: { increment: 1 } },
        select: { id: true },
      }),
      this.prisma.auditLog.create({
        data: {
          username: operator,
          action: 'MEMBER_STATUS',
          details: `账号 ${id}；停用 ${disabled}${ipSuffix}`,
        },
      }),
    ]);
    return { success: true };
  }
  async resetPassword(id: string, password: string, operator: string, clientIp?: string) {
    const member = await this.prisma.memberAccount.findUniqueOrThrow({ where: { id } });
    const hashed = await hashPassword(password);
    const ipSuffix = clientIp ? ` (来源 IP: ${clientIp})` : '';
    await this.prisma.$transaction(async (tx) => {
      await tx.memberAccount.update({
        where: { id },
        data: { password: hashed, sessionVersion: { increment: 1 } },
        select: { id: true },
      });

      // 原子清空该账号在 AuthRateLimit 中的限流计数桶
      const paths = ['/api/v1/member-auth/login', '/member-auth/login'];
      const windowMs = 10 * 60 * 1000;
      const currentSlot = Math.floor(Date.now() / windowMs);
      const key = `account:${member.username.trim().slice(0, 128)}`;
      const idsToDelete = [
        createHash('sha256').update(`${paths[0]}:${currentSlot}:${key}`).digest('hex'),
        createHash('sha256').update(`${paths[1]}:${currentSlot}:${key}`).digest('hex'),
        createHash('sha256').update(`${paths[0]}:${currentSlot - 1}:${key}`).digest('hex'),
        createHash('sha256').update(`${paths[1]}:${currentSlot - 1}:${key}`).digest('hex'),
      ];

      await tx.authRateLimit.deleteMany({
        where: { id: { in: idsToDelete } },
      });
      for (const path of paths) {
        const prefix = loginLimitPrefix(path, key);
        // Serialize reset with in-flight login accounting; retain the lock row.
        await tx.authRateLimit.upsert({
          where: { id: `${prefix}lock` },
          create: { id: `${prefix}lock`, count: 1, expiresAt: new Date(Date.now() + 1200_000) },
          update: { expiresAt: new Date(Date.now() + 1200_000) },
        });
        await tx.authRateLimit.deleteMany({ where: { id: { startsWith: `${prefix}event:` } } });
      }

      await tx.auditLog.create({
        data: {
          username: operator,
          action: 'MEMBER_PASSWORD_RESET',
          details: `经人工核验重置账号 ${id} (${member.username}) 密码并清空账号限流${ipSuffix}`,
        },
      });
    });
    return { success: true };
  }
  async cleanup(memberId?: string) {
    const now = new Date();

    // 仅在全量定时维护 (!memberId) 时扫描孤立超时 STAGING 资产并纳入物理清理队列
    if (!memberId) {
      await this.prisma.campusCardAsset
        .updateMany({
          where: {
            memberId: null,
            state: 'STAGING',
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
          },
          data: {
            state: 'DELETE_PENDING',
            deleteAfter: now,
            nextAttemptAt: now,
          },
        })
        .catch(() => this.logger.error('过期校园卡暂存任务调度失败，账本保留等待下次重试'));
    }

    const due = await this.prisma.campusCardAsset.findMany({
      where: {
        ...(memberId ? { memberId } : {}),
        state: { not: 'DELETED' },
        deleteAfter: { lte: now },
        nextAttemptAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      take: 25,
      // Retried unresolved writes move behind already-due work, preventing starvation.
      orderBy: [{ nextAttemptAt: 'asc' }, { deleteAfter: 'asc' }, { id: 'asc' }],
    });
    let deleted = 0;
    for (const asset of due) {
      const claimed = await this.prisma.campusCardAsset.updateMany({
        where: {
          id: asset.id,
          state: { not: 'DELETED' },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
        },
        data: {
          state: 'DELETE_PENDING',
          leaseUntil: new Date(Date.now() + 300_000),
          attempts: { increment: 1 },
        },
      });
      if (!claimed.count) continue;
      try {
        if (asset.memberId)
          await this.prisma.memberAccount.updateMany({
            where: {
              id: asset.memberId,
              verificationStatus: 'PENDING',
              verificationVersion: asset.version,
            },
            data: {
              verificationStatus: 'CHANGES_REQUESTED',
              reviewComment: '材料已到期，请重新上传校园卡',
            },
          });
        await this.store.remove(asset.objectKey);
        if (asset.uploadSettled === false) {
          // 未决 PUT 可能在这次 DELETE/HEAD 之后才完成。持续清理，但绝不释放配额。
          await this.prisma.campusCardAsset.update({
            where: { id: asset.id },
            data: { leaseUntil: null, nextAttemptAt: new Date(Date.now() + 60_000) },
          });
          this.logger.warn(`校园卡写入结果未确认，保留配额并继续清理：${asset.id}`);
          continue;
        }
        await this.prisma.campusCardAsset.update({
          where: { id: asset.id },
          data: { state: 'DELETED', deletedAt: new Date(), leaseUntil: null },
        });
        deleted++;
      } catch {
        this.logger.error(`校园卡清理失败，已安排重试：${asset.id}`);
        await this.prisma.campusCardAsset.update({
          where: { id: asset.id },
          data: {
            leaseUntil: null,
            nextAttemptAt: new Date(
              Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(asset.attempts, 7)),
            ),
          },
        });
      }
    }
    await this.prisma.authRateLimit.deleteMany({ where: { expiresAt: { lt: now } } });
    return { deleted, attempted: due.length };
  }
}
