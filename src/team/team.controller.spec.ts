import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';
import { TeamQueryService } from './team-query.service';
import { TeamRosterService } from './team-roster.service';

describe('TeamController', () => {
  let controller: TeamController;
  let teamQueryService: TeamQueryService;

  const mockTeamService = {
    createWithPlayers: jest.fn(),
    create: jest.fn(),
    updateWithPlayers: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  const mockTeamQueryService = {
    findAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10 }),
    findPublicAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10 }),
    searchByName: jest.fn(),
    searchPublicByName: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ id: 'coach_team_1', teamName: '教练所属球队' }),
  };

  const mockTeamRosterService = {
    getTeamRoster: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TeamController],
      providers: [
        { provide: TeamService, useValue: mockTeamService },
        { provide: TeamQueryService, useValue: mockTeamQueryService },
        { provide: TeamRosterService, useValue: mockTeamRosterService },
      ],
    }).compile();

    controller = module.get<TeamController>(TeamController);
    teamQueryService = module.get<TeamQueryService>(TeamQueryService);
    jest.clearAllMocks();
  });

  describe('findAdminAll (教练权限及团队隔离)', () => {
    it('超级管理员可以获取全量球队数据', async () => {
      const req = { user: { role: 'super_admin' } };
      await controller.findAdminAll(1, 10, 'season_1', undefined, req);
      expect(teamQueryService.findAll).toHaveBeenCalledWith(1, 10, 'season_1', undefined);
    });

    it('教练角色必须只能查到本队且 total 为 1', async () => {
      const req = { user: { role: 'coach', teamId: 'coach_team_1' } };
      const res = await controller.findAdminAll(1, 10, undefined, undefined, req);
      expect(teamQueryService.findOne).toHaveBeenCalledWith('coach_team_1', undefined);
      expect(res.data.length).toBe(1);
      expect(res.total).toBe(1);
      expect(res.data[0].id).toBe('coach_team_1');
    });

    it('未绑定球队的教练访问管理列表应该被拒绝', async () => {
      const req = { user: { role: 'coach', teamId: null } };
      await expect(controller.findAdminAll(1, 10, undefined, undefined, req)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('教练只能更新自己归属的球队信息，试图更新其他球队抛出 ForbiddenException', async () => {
      const req = { user: { role: 'coach', teamId: 'my_team' } };
      expect(() => controller.update('other_team', { teamName: '篡改队名' }, req)).toThrow(
        ForbiddenException,
      );
    });
  });
});
