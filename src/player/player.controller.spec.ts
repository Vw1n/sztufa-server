import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { PlayerController } from './player.controller';
import { PlayerService } from './player.service';

describe('PlayerController', () => {
  let controller: PlayerController;
  let service: PlayerService;

  const mockPlayerService = {
    create: jest.fn(),
    findAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10 }),
    findPublicAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10 }),
    searchByName: jest.fn(),
    searchPublicByName: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    findPublicOne: jest.fn(),
    getCareerStats: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlayerController],
      providers: [
        {
          provide: PlayerService,
          useValue: mockPlayerService,
        },
      ],
    }).compile();

    controller = module.get<PlayerController>(PlayerController);
    service = module.get<PlayerService>(PlayerService);
    jest.clearAllMocks();
  });

  describe('findAdminAll (权限与 Pre-Query 隔离)', () => {
    it('超级管理员不传 teamId 时可以查询全量球员', async () => {
      const req = { user: { role: 'super_admin' } };
      await controller.findAdminAll(1, 10, undefined, req);
      expect(service.findAll).toHaveBeenCalledWith(undefined, 1, 10);
    });

    it('超级管理员可以传入任意 teamId 查询对应球队球员', async () => {
      const req = { user: { role: 'super_admin' } };
      await controller.findAdminAll(1, 10, 'team_123', req);
      expect(service.findAll).toHaveBeenCalledWith('team_123', 1, 10);
    });

    it('教练角色即便传入其他 teamId，也必须强行被重写为其归属的 teamId', async () => {
      const req = { user: { role: 'coach', teamId: 'coach_my_team' } };
      await controller.findAdminAll(1, 10, 'other_team_spoofed', req);
      expect(service.findAll).toHaveBeenCalledWith('coach_my_team', 1, 10);
    });

    it('教练角色未绑定 teamId 时应该抛出 ForbiddenException', async () => {
      const req = { user: { role: 'coach', teamId: null } };
      await expect(controller.findAdminAll(1, 10, undefined, req)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
