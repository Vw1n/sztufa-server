import { Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
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
    const { username, password, role, teamId } = createUserDto;
    const hashedPassword = await bcrypt.hash(password, 10);

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

    await this.auditLogService.log(
      username,
      'USER_LOGIN',
      `用户 "${username}" 成功登录系统`,
    );

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

  async updateUserRole(id: string, role: string, teamId: string | null, operatorUsername: string = 'admin') {
    const userBefore = await this.prisma.user.findUnique({ where: { id }, include: { team: true } });
    if (!userBefore) {
      throw new NotFoundException('该用户账号不存在');
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

    const details = diffs.length > 0
      ? `修改用户 "${updatedUser.username}" 权限: ${diffs.join(', ')}`
      : `保存用户 "${updatedUser.username}" 权限(未改动)`;

    await this.auditLogService.log(operatorUsername, 'UPDATE_USER_ROLE', details);

    return updatedUser;
  }

  async deleteUser(id: string, operatorUsername: string = 'admin') {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('该用户账号不存在');
    }
    
    const deletedUser = await this.prisma.user.delete({
      where: { id },
    });

    await this.auditLogService.log(
      operatorUsername,
      'DELETE_USER',
      `删除账号: "${user.username}"`,
    );

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
