import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BadRequestException } from '@nestjs/common';

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
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getCurrentUser (via validateUser)', () => {
    it('should return user when token is valid', async () => {
      const mockUser = { id: '1', username: 'admin', role: 'super_admin', teamId: null };
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.validateUser({ userId: '1' });
      expect(result).toEqual(mockUser);
      expect(prismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: '1' },
        select: { id: true, username: true, role: true, teamId: true },
      });
    });

    it('should return null when user not found', async () => {
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.validateUser({ userId: '999' });
      expect(result).toBeNull();
    });
  });

  describe('createUser (register)', () => {
    it('should create user with valid data', async () => {
      const mockUser = {
        id: '1',
        username: 'newuser',
        role: 'user',
        teamId: null,
        createdAt: new Date(),
      };
      (prismaService.user.create as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.register({
        username: 'newuser',
        password: 'password123',
        role: 'user',
      });

      expect(result.user).toBeDefined();
      expect(result.token).toBe('test-token');
      expect(prismaService.user.create).toHaveBeenCalled();
    });

    it('should reject invalid teamId for coach', async () => {
      (prismaService.team.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.register({
          username: 'coach',
          password: 'password123',
          role: 'coach',
          teamId: 'invalid-team',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should clear teamId for non-coach roles', async () => {
      const mockUser = {
        id: '1',
        username: 'user',
        role: 'user',
        teamId: null,
        createdAt: new Date(),
      };
      (prismaService.user.create as jest.Mock).mockResolvedValue(mockUser);

      await service.register({
        username: 'user',
        password: 'password123',
        role: 'user',
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
      const mockUser = { id: '2', username: 'other', role: 'user' };
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

      await expect(service.updateUserRole('1', 'user', null, 'admin', '1')).rejects.toThrow(
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

      await expect(service.updateUserRole('1', 'user', null, 'other-admin', '2')).rejects.toThrow(
        '不能降级最后一个超级管理员',
      );
    });
  });
});
