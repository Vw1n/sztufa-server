import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BadRequestException } from '@nestjs/common';
import { hashPassword } from './password';
import * as bcrypt from 'bcryptjs';

describe('AuthService', () => {
  let service: AuthService;
  let prismaService: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
            team: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('test-token'),
          },
        },
        {
          provide: AuditLogService,
          useValue: {
            log: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prismaService = module.get<PrismaService>(PrismaService);
    (prismaService as any).auditLog = { create: jest.fn() };
    (prismaService as any).$transaction = jest.fn(async (fn) => fn(prismaService));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('新口令不截断 72 字节之后的内容，登录令牌仅用于后台', async () => {
    const password = `${'campus-long-pass-'.repeat(5)}A`;
    (prismaService.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'staff-1',
      username: 'admin',
      role: 'super_admin',
      sessionVersion: 0,
      password: await hashPassword(password),
    });
    await expect(service.login({ username: 'admin', password })).resolves.toHaveProperty('token');
    await expect(
      service.login({ username: 'admin', password: `${password.slice(0, -1)}B` }),
    ).rejects.toMatchObject({ status: 401 });
    expect((service as any).jwtService.sign).toHaveBeenCalledWith(
      expect.objectContaining({ accountType: 'staff', sessionVersion: 0 }),
      expect.objectContaining({ audience: 'staff' }),
    );
  });

  it('旧 bcrypt 口令仍可登录，旧普通用户不能使用后台认证', async () => {
    const user = {
      id: 'legacy-1',
      username: 'legacy',
      role: 'coach',
      sessionVersion: 0,
      password: await bcrypt.hash('legacy-short', 4),
    };
    (prismaService.user.findUnique as jest.Mock).mockResolvedValue(user);
    await expect(
      service.login({ username: 'legacy', password: 'legacy-short' }),
    ).resolves.toHaveProperty('token');
    (prismaService.user.findUnique as jest.Mock).mockResolvedValue({ ...user, role: 'user' });
    await expect(
      service.login({ username: 'legacy', password: 'legacy-short' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  describe('getCurrentUser (via validateUser)', () => {
    it('should return user when token is valid', async () => {
      const mockUser = {
        id: '1',
        username: 'admin',
        sessionVersion: 0,
        studentId: null,
        nickname: 'admin',
        role: 'super_admin',
        teamId: null,
      };
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.validateUser({
        userId: '1',
        accountType: 'staff',
        aud: 'staff',
        sessionVersion: 0,
      });
      expect(result).toEqual(mockUser);
      expect(prismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: '1' },
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
    });

    it('should return null when user not found', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.validateUser({
        userId: '999',
        accountType: 'staff',
        aud: 'staff',
        sessionVersion: 0,
      });
      expect(result).toBeNull();
    });
  });

  it('旧注册入口不可绕过校园卡审核', async () => {
    await expect(
      service.registerStudent({
        username: 'student',
        password: 'Long-campus-pass!2026',
        studentId: '20260001',
      }),
    ).rejects.toThrow('旧注册接口已关闭');
    expect(prismaService.user.create).not.toHaveBeenCalled();
  });
  it('后台不可创建普通用户', async () => {
    await expect(
      service.register({ username: 'student', password: 'Long-campus-pass!2026', role: 'user' }),
    ).rejects.toThrow('后台仅能创建工作人员');
  });
  it('拒绝旧令牌及普通用户受众', async () => {
    expect(await service.validateUser({ userId: '1' })).toBeNull();
    expect(
      await service.validateUser({ userId: '1', accountType: 'member', aud: 'member' }),
    ).toBeNull();
  });
  describe('createUser (register)', () => {
    it('should create user with valid data', async () => {
      const mockUser = {
        id: '1',
        username: 'newuser',
        studentId: '2023123456',
        nickname: 'newuser',
        role: 'match_scorer',
        teamId: null,
        createdAt: new Date(),
      };
      (prismaService.user.create as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.register({
        username: 'newuser',
        studentId: '2023123456',
        password: 'Long-campus-pass!2026',
        role: 'match_scorer',
      });

      expect(result.user).toBeDefined();
      expect(result).not.toHaveProperty('token');
      expect(prismaService.user.create).toHaveBeenCalled();
    });

    it('should reject invalid teamId for coach', async () => {
      (prismaService.team.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.register({
          username: 'coach',
          password: 'Long-campus-pass!2026',
          role: 'coach',
          teamId: 'invalid-team',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should clear teamId for non-coach roles', async () => {
      const mockUser = {
        id: '1',
        username: 'user',
        studentId: '2023123456',
        role: 'match_scorer',
        teamId: null,
        createdAt: new Date(),
      };
      (prismaService.user.create as jest.Mock).mockResolvedValue(mockUser);

      await service.register({
        username: 'user',
        studentId: '2023123456',
        password: 'Long-campus-pass!2026',
        role: 'match_scorer',
        teamId: 'some-team',
      });

      expect(prismaService.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            teamId: null,
          }),
        }),
      );
    });
  });

  describe('deleteUser - self-deletion protection', () => {
    it('should prevent user from deleting themselves', async () => {
      const mockUser = { id: '1', username: 'admin', role: 'super_admin' };
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      await expect(service.deleteUser('1', 'admin', '1')).rejects.toThrow('不能删除自己的账号');
    });

    it('should allow deleting other users', async () => {
      const mockUser = { id: '2', username: 'other', role: 'match_scorer' };
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prismaService.user.delete as jest.Mock).mockResolvedValue(mockUser);

      await service.deleteUser('2', 'admin', '1');
      expect(prismaService.user.delete).toHaveBeenCalled();
    });
  });

  describe('deleteUser - last super admin protection', () => {
    it('should prevent deleting the last super admin', async () => {
      const mockUser = { id: '1', username: 'admin', role: 'super_admin' };
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prismaService.user.count as jest.Mock).mockResolvedValue(1);

      await expect(service.deleteUser('1', 'other-admin', '2')).rejects.toThrow(
        '不能删除最后一个超级管理员',
      );
    });

    it('should allow deleting super admin when there are others', async () => {
      const mockUser = { id: '1', username: 'admin', role: 'super_admin' };
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prismaService.user.count as jest.Mock).mockResolvedValue(2);
      (prismaService.user.delete as jest.Mock).mockResolvedValue(mockUser);

      await service.deleteUser('1', 'other-admin', '2');
      expect(prismaService.user.delete).toHaveBeenCalled();
    });
  });

  describe('updateUserRole - self-downgrade protection', () => {
    it('should prevent user from downgrading themselves', async () => {
      const mockUser = { id: '1', username: 'admin', role: 'super_admin', team: null };
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      await expect(service.updateUserRole('1', 'match_scorer', null, 'admin', '1')).rejects.toThrow(
        '不能降级自己的账号',
      );
    });

    it('should allow changing own teamId without role change', async () => {
      const mockUser = { id: '1', username: 'admin', role: 'super_admin', team: null };
      const updatedUser = { ...mockUser, teamId: 'team1', team: { teamName: 'Team 1' } };
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prismaService.user.update as jest.Mock).mockResolvedValue(updatedUser);

      const result = await service.updateUserRole('1', 'super_admin', 'team1', 'admin', '1');
      expect(result).toBeDefined();
    });
  });

  describe('updateUserRole - last super admin protection', () => {
    it('should prevent downgrading the last super admin', async () => {
      const mockUser = { id: '1', username: 'admin', role: 'super_admin', team: null };
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prismaService.user.count as jest.Mock).mockResolvedValue(1);

      await expect(
        service.updateUserRole('1', 'match_scorer', null, 'other-admin', '2'),
      ).rejects.toThrow('不能降级最后一个超级管理员');
    });
  });
});
