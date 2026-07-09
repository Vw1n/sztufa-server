import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
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

    const token = this.jwtService.sign({ userId: user.id, role: user.role });
    return { user, token };
  }

  async login(loginDto: LoginDto) {
    const { username, password } = loginDto;
    const user = await this.prisma.user.findUnique({ where: { username } });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('用户名或密码错误');
    }

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

  async updateUserRole(id: string, role: string, teamId: string | null) {
    return this.prisma.user.update({
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
      },
    });
  }

  async deleteUser(id: string) {
    return this.prisma.user.delete({
      where: { id },
    });
  }

  async resetPassword(id: string, newPassword: string) {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    return this.prisma.user.update({
      where: { id },
      data: { password: hashedPassword },
      select: {
        id: true,
        username: true,
        role: true,
      },
    });
  }
}
