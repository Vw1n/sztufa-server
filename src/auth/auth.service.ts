import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { CreateUserDto } from './dto/create-user.dto';
import { StudentRegisterDto } from './dto/student-register.dto';
import { LoginDto } from './dto/login.dto';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async registerStudent(_dto: StudentRegisterDto) {
    throw new BadRequestException('旧注册接口已关闭，请使用校园卡注册页面');
  }

  async register(createUserDto: CreateUserDto) {
    const { username, password, studentId, nickname } = createUserDto;
    const role = createUserDto.role || 'match_scorer';
    if (!['super_admin', 'coach', 'match_scorer', 'news_editor'].includes(role))
      throw new BadRequestException('后台仅能创建工作人员账号');
    let teamId = createUserDto.teamId;

    const trimmedUsername = username?.trim();
    if (!trimmedUsername) {
      throw new BadRequestException('用户名不能为空');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { username: trimmedUsername },
    });
    if (existingUser) {
      throw new ConflictException('用户名已被注册');
    }

    const trimmedStudentId = studentId?.trim() || null;
    if (role === 'user') {
      if (!trimmedStudentId) {
        throw new BadRequestException('普通用户注册必须填写学号');
      }
      const existingStudentId = await this.prisma.user.findUnique({
        where: { studentId: trimmedStudentId },
      });
      if (existingStudentId) {
        throw new ConflictException('该学号已被其他账号绑定');
      }
    } else if (trimmedStudentId) {
      const existingStudentId = await this.prisma.user.findUnique({
        where: { studentId: trimmedStudentId },
      });
      if (existingStudentId) {
        throw new ConflictException('该学号已被其他账号绑定');
      }
    }

    const hashedPassword = await hashPassword(password);

    // P0-6: 校验球队绑定规则
    // 教练可以不绑定球队，管理员可以后续绑定
    // 非教练角色自动清空 teamId
    if (role !== 'coach' && teamId) {
      teamId = null;
    }

    // 校验球队是否存在（如果提供了 teamId）
    if (teamId) {
      const team = await this.prisma.team.findUnique({ where: { id: teamId } });
      if (!team) {
        throw new BadRequestException('绑定的球队不存在');
      }
    }

    const user = await this.prisma.user.create({
      data: {
        username: trimmedUsername,
        password: hashedPassword,
        role,
        studentId: trimmedStudentId,
        nickname: nickname?.trim() || trimmedUsername,
        teamId: teamId || null,
      },
      select: {
        id: true,
        username: true,
        studentId: true,
        nickname: true,
        role: true,
        teamId: true,
        createdAt: true,
      },
    });

    await this.auditLogService.log(
      'system',
      'USER_REGISTER',
      `新建账号: "${user.username}" (角色: ${user.role}, 学号: ${user.studentId || '无'})`,
    );

    return { user };
  }

  async login(loginDto: LoginDto) {
    const { username, password } = loginDto;
    const user = await this.prisma.user.findUnique({ where: { username: username.trim() } });

    if (!user || user.role === 'user' || !(await verifyPassword(password, user.password))) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    await this.auditLogService.log(username, 'USER_LOGIN', `用户 "${username}" 成功登录系统`);

    const token = this.jwtService.sign(
      {
        userId: user.id,
        role: user.role,
        accountType: 'staff',
        sessionVersion: user.sessionVersion,
      },
      { audience: 'staff', algorithm: 'HS256' },
    );
    return {
      user: {
        id: user.id,
        username: user.username,
        studentId: user.studentId,
        nickname: user.nickname || user.username,
        role: user.role,
        teamId: user.teamId,
      },
      token,
    };
  }

  async validateUser(payload: any) {
    if (
      payload.accountType !== 'staff' ||
      payload.aud !== 'staff' ||
      typeof payload.userId !== 'string'
    )
      return null;
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        username: true,
        studentId: true,
        nickname: true,
        role: true,
        teamId: true,
        sessionVersion: true,
      },
    });
    return user && user.role !== 'user' && user.sessionVersion === payload.sessionVersion
      ? user
      : null;
  }

  async getAllUsers() {
    return this.prisma.user.findMany({
      where: { role: { in: ['super_admin', 'coach', 'match_scorer', 'news_editor'] } },
      select: {
        id: true,
        username: true,
        studentId: true,
        nickname: true,
        role: true,
        teamId: true,
        createdAt: true,
      },
      orderBy: { username: 'asc' },
    });
  }

  async updateUserStudentId(
    id: string,
    studentId: string | null,
    operatorUsername: string = 'admin',
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('该用户账号不存在');
    }

    const trimmed = studentId?.trim() || null;
    if (user.role === 'user' && !trimmed) {
      throw new BadRequestException('普通用户必须绑定学号');
    }

    if (trimmed) {
      const existing = await this.prisma.user.findFirst({
        where: { studentId: trimmed, NOT: { id } },
      });
      if (existing) {
        throw new BadRequestException('该学号已被其他账号绑定');
      }
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: { studentId: trimmed },
      select: {
        id: true,
        username: true,
        studentId: true,
        nickname: true,
        role: true,
      },
    });

    await this.auditLogService.log(
      operatorUsername,
      'UPDATE_STUDENT_ID',
      `修改用户 "${user.username}" 学号绑定: ${trimmed || '解绑'}`,
    );

    return updatedUser;
  }

  // P0-5: 检查是否是最后一个超级管理员
  private async isLastSuperAdmin(userId: string): Promise<boolean> {
    const superAdminCount = await this.prisma.user.count({
      where: { role: 'super_admin' },
    });

    // 如果只有一个超级管理员，且要操作的是这个超级管理员，则是最后一个
    if (superAdminCount <= 1) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });
      return user?.role === 'super_admin';
    }

    return false;
  }

  async updateUserRole(
    id: string,
    role: string,
    teamId: string | null,
    operatorUsername: string = 'admin',
    operatorId?: string,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        if (!['super_admin', 'coach', 'match_scorer', 'news_editor'].includes(role))
          throw new BadRequestException('不能将后台账号转换为普通用户');
        const userBefore = await tx.user.findUnique({
          where: { id },
          include: { team: true },
        });
        if (!userBefore) {
          throw new NotFoundException('该用户账号不存在');
        }

        // P0-5: 禁止当前用户降级自己
        if (operatorId && id === operatorId && role !== 'super_admin') {
          throw new BadRequestException('不能降级自己的账号，请联系其他超级管理员操作');
        }

        // P0-5: 保护最后一个超级管理员
        if (userBefore.role === 'super_admin' && role !== 'super_admin') {
          const isLast = (await tx.user.count({ where: { role: 'super_admin' } })) <= 1;
          if (isLast) {
            throw new BadRequestException('不能降级最后一个超级管理员，否则系统将无法管理');
          }
        }

        // P0-6: 校验球队绑定规则
        // 教练可以不绑定球队，管理员可以后续绑定
        // 非教练角色自动清空 teamId
        if (role !== 'coach' && teamId) {
          teamId = null;
        }

        // 校验球队是否存在（如果提供了 teamId）
        if (teamId) {
          const team = await tx.team.findUnique({ where: { id: teamId } });
          if (!team) {
            throw new BadRequestException('绑定的球队不存在');
          }
        }

        const updatedUser = await tx.user.update({
          where: { id },
          data: {
            role,
            sessionVersion: { increment: 1 },
            teamId: teamId || null,
          },
          select: {
            id: true,
            username: true,
            role: true,
            teamId: true,
            team: true,
          },
        });

        const diffs: string[] = [];
        if (userBefore.role !== role) {
          diffs.push(`角色: ${userBefore.role}->${role}`);
        }
        if (userBefore.teamId !== teamId) {
          const oldTeamName = userBefore.team?.teamName || '无';
          const newTeamName = updatedUser.team?.teamName || '无';
          diffs.push(`绑定球队: ${oldTeamName}->${newTeamName}`);
        }

        const details =
          diffs.length > 0
            ? `修改用户 "${updatedUser.username}" 权限: ${diffs.join(', ')}`
            : `保存用户 "${updatedUser.username}" 权限(未改动)`;

        await tx.auditLog.create({
          data: { username: operatorUsername, action: 'UPDATE_USER_ROLE', details },
        });

        return updatedUser;
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async deleteUser(id: string, operatorUsername: string = 'admin', operatorId?: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findUnique({ where: { id } });
        if (!user) {
          throw new NotFoundException('该用户账号不存在');
        }

        // P0-5: 禁止当前用户删除自己
        if (operatorId && id === operatorId) {
          throw new BadRequestException('不能删除自己的账号，请联系其他超级管理员操作');
        }

        // P0-5: 保护最后一个超级管理员
        if (user.role === 'super_admin') {
          const isLast = (await tx.user.count({ where: { role: 'super_admin' } })) <= 1;
          if (isLast) {
            throw new BadRequestException('不能删除最后一个超级管理员，否则系统将无法管理');
          }
        }

        const deletedUser = await tx.user.delete({
          where: { id },
        });

        await tx.auditLog.create({
          data: {
            username: operatorUsername,
            action: 'DELETE_USER',
            details: `删除账号: ${user.id}`,
          },
        });

        return { id: deletedUser.id, username: deletedUser.username };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async resetPassword(id: string, newPassword: string, operatorUsername: string = 'admin') {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('该用户账号不存在');
    }
    const hashedPassword = await hashPassword(newPassword);

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: { password: hashedPassword, sessionVersion: { increment: 1 } },
      select: {
        id: true,
        username: true,
        role: true,
      },
    });

    await this.auditLogService.log(
      operatorUsername,
      'RESET_USER_PASSWORD',
      `重置用户 "${user.username}" 密码`,
    );

    return updatedUser;
  }
}
