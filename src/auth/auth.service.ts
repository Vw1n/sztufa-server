import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async register(createUserDto: CreateUserDto) {
    const { username, password, role } = createUserDto;
    let { teamId } = createUserDto;
    const hashedPassword = await bcrypt.hash(password, 10);

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
        username,
        password: hashedPassword,
        role: role || 'user',
        teamId: teamId || null,
      },
      select: {
        id: true,
        username: true,
        role: true,
        teamId: true,
        createdAt: true,
      },
    });

    await this.auditLogService.log(
      'system',
      'USER_REGISTER',
      `新建账号: "${username}" (角色: ${user.role})`,
    );

    const token = this.jwtService.sign({ userId: user.id, role: user.role });
    return { user, token };
  }

  async login(loginDto: LoginDto) {
    const { username, password } = loginDto;
    const user = await this.prisma.user.findUnique({ where: { username } });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    await this.auditLogService.log(username, 'USER_LOGIN', `用户 "${username}" 成功登录系统`);

    const token = this.jwtService.sign({ userId: user.id, role: user.role });
    return {
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        teamId: user.teamId,
      },
      token,
    };
  }

  async validateUser(payload: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, username: true, role: true, teamId: true },
    });
    return user;
  }

  async getAllUsers() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        role: true,
        teamId: true,
        createdAt: true,
      },
      orderBy: { username: 'asc' },
    });
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
    const userBefore = await this.prisma.user.findUnique({
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
      const isLast = await this.isLastSuperAdmin(id);
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
      const team = await this.prisma.team.findUnique({ where: { id: teamId } });
      if (!team) {
        throw new BadRequestException('绑定的球队不存在');
      }
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: {
        role,
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

    await this.auditLogService.log(operatorUsername, 'UPDATE_USER_ROLE', details);

    return updatedUser;
  }

  async deleteUser(id: string, operatorUsername: string = 'admin', operatorId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('该用户账号不存在');
    }

    // P0-5: 禁止当前用户删除自己
    if (operatorId && id === operatorId) {
      throw new BadRequestException('不能删除自己的账号，请联系其他超级管理员操作');
    }

    // P0-5: 保护最后一个超级管理员
    if (user.role === 'super_admin') {
      const isLast = await this.isLastSuperAdmin(id);
      if (isLast) {
        throw new BadRequestException('不能删除最后一个超级管理员，否则系统将无法管理');
      }
    }

    const deletedUser = await this.prisma.user.delete({
      where: { id },
    });

    await this.auditLogService.log(operatorUsername, 'DELETE_USER', `删除账号: "${user.username}"`);

    return deletedUser;
  }

  async resetPassword(id: string, newPassword: string, operatorUsername: string = 'admin') {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('该用户账号不存在');
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: { password: hashedPassword },
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
