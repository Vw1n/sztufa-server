import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { RegistrationStatus } from '@prisma/client';
import { RegistrationService, UserContext } from './registration.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TeamRosterService } from '../team/team-roster.service';

describe('RegistrationService', () => {
  let service: RegistrationService;
  let prisma: any;
  let auditLogService: any;
  let teamRosterService: any;

  const mockCoachUser: UserContext = {
    id: 'user-coach-1',
    username: 'coach1',
    role: 'coach',
    teamId: 'team-1',
  };

  const mockOtherCoachUser: UserContext = {
    id: 'user-coach-2',
    username: 'coach2',
    role: 'coach',
    teamId: 'team-2',
  };

  const mockCoachWithoutTeam: UserContext = {
    id: 'user-coach-3',
    username: 'coach3',
    role: 'coach',
    teamId: null,
  };

  const mockSuperAdminUser: UserContext = {
    id: 'user-admin-1',
    username: 'admin1',
    role: 'super_admin',
    teamId: null,
  };

  beforeEach(async () => {
    prisma = {
      season: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      team: {
        findUnique: jest.fn(),
      },
      teamRegistration: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn(),
      },
      registrationTeamData: {
        upsert: jest.fn(),
      },
      registrationPlayer: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      seasonTeamProfile: {
        upsert: jest.fn(),
      },
      seasonTeamPlayer: {
        deleteMany: jest.fn(),
      },
      player: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        create: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      $transaction: jest.fn((cb) => cb(prisma)),
    };

    auditLogService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    teamRosterService = {
      registerPlayer: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: auditLogService },
        { provide: TeamRosterService, useValue: teamRosterService },
      ],
    }).compile();

    service = module.get<RegistrationService>(RegistrationService);
  });

  describe('checkCoachTeamBinding & Ownership', () => {
    it('should throw ForbiddenException if coach is not bound to a team', async () => {
      await expect(service.getMine('season-1', mockCoachWithoutTeam)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw ForbiddenException if coach accesses another team registration', async () => {
      prisma.teamRegistration.findUnique.mockResolvedValue({
        id: 'reg-1',
        teamId: 'team-1',
      });
      await expect(service.getDetail('reg-1', mockOtherCoachUser)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('save & submit status rules', () => {
    it('should allow saving in DRAFT status and handle partial teamData without wiping unspecified fields', async () => {
      prisma.teamRegistration.findUnique.mockResolvedValue({
        id: 'reg-1',
        teamId: 'team-1',
        status: RegistrationStatus.DRAFT,
        teamData: { teamName: 'Original Alpha', gender: 'MALE' },
      });

      await service.save(
        'reg-1',
        {
          teamData: { headCoach: 'New Coach' },
        },
        mockCoachUser,
      );

      expect(prisma.registrationTeamData.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ headCoach: 'New Coach' }),
        }),
      );
      // Ensure teamName was not set to empty string in updateData
      const updateArg = prisma.registrationTeamData.upsert.mock.calls[0][0].update;
      expect(updateArg.teamName).toBeUndefined();
    });

    it('should reject blob: or data: image URLs with BadRequestException', async () => {
      prisma.teamRegistration.findUnique.mockResolvedValue({
        id: 'reg-1',
        teamId: 'team-1',
        status: RegistrationStatus.DRAFT,
      });

      await expect(
        service.save(
          'reg-1',
          { teamData: { teamLogo: 'blob:http://localhost/123-456' } },
          mockCoachUser,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should detach stale or cross-team player IDs while preserving registration snapshots', async () => {
      prisma.teamRegistration.findUnique
        .mockResolvedValueOnce({
          id: 'reg-1',
          teamId: 'team-1',
          status: RegistrationStatus.DRAFT,
          teamData: { teamName: 'Team Alpha' },
        })
        .mockResolvedValueOnce({
          id: 'reg-1',
          teamId: 'team-1',
          status: RegistrationStatus.DRAFT,
          teamData: { teamName: 'Team Alpha' },
          players: [],
        });
      prisma.player.findMany.mockResolvedValue([{ id: 'player-valid' }]);

      await service.save(
        'reg-1',
        {
          players: [
            { playerId: 'player-valid', name: 'Valid', studentId: '1', jerseyNumber: '9' },
            { playerId: 'player-stale', name: 'Stale', studentId: '2', jerseyNumber: '10' },
          ],
        },
        mockCoachUser,
      );

      expect(prisma.player.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['player-valid', 'player-stale'] },
          teamId: 'team-1',
          deletedAt: null,
        },
        select: { id: true },
      });
      expect(prisma.registrationPlayer.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ playerId: 'player-valid', name: 'Valid' }),
          expect.objectContaining({ playerId: null, name: 'Stale' }),
        ],
      });
    });

    it('should throw ConflictException (409) when saving in SUBMITTED status or if updateMany lock fails', async () => {
      prisma.teamRegistration.updateMany.mockResolvedValue({ count: 0 });
      prisma.teamRegistration.findUnique.mockResolvedValue({
        id: 'reg-1',
        teamId: 'team-1',
        status: RegistrationStatus.SUBMITTED,
      });

      await expect(
        service.save('reg-1', { teamData: { teamName: 'Attempted' } }, mockCoachUser),
      ).rejects.toThrow(ConflictException);
    });

    it('should lock status first via updateMany, fetch latest snapshot, and submit successfully', async () => {
      prisma.teamRegistration.updateMany.mockResolvedValue({ count: 1 });
      prisma.teamRegistration.findUnique.mockResolvedValue({
        id: 'reg-1',
        teamId: 'team-1',
        status: RegistrationStatus.SUBMITTED,
        teamData: { teamName: 'Team Alpha' },
        players: [{ name: 'Player A' }],
      });

      const res = await service.submit('reg-1', mockCoachUser);
      expect(res.status).toBe(RegistrationStatus.SUBMITTED);
      expect(prisma.teamRegistration.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'reg-1',
          teamId: 'team-1',
          status: { in: [RegistrationStatus.DRAFT, RegistrationStatus.CHANGES_REQUESTED] },
        },
        data: expect.objectContaining({
          status: RegistrationStatus.SUBMITTED,
        }),
      });
    });

    it('should throw BadRequestException after acquiring lock if players list is empty', async () => {
      prisma.teamRegistration.updateMany.mockResolvedValue({ count: 1 });
      prisma.teamRegistration.findUnique.mockResolvedValue({
        id: 'reg-1',
        teamId: 'team-1',
        status: RegistrationStatus.SUBMITTED,
        teamData: { teamName: 'Team Alpha' },
        players: [],
      });

      await expect(service.submit('reg-1', mockCoachUser)).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException (409) when submitting if updateMany count is 0 (concurrent submit)', async () => {
      prisma.teamRegistration.updateMany.mockResolvedValue({ count: 0 });
      prisma.teamRegistration.findUnique.mockResolvedValue({
        id: 'reg-1',
        teamId: 'team-1',
        status: RegistrationStatus.SUBMITTED,
      });

      await expect(service.submit('reg-1', mockCoachUser)).rejects.toThrow(ConflictException);
    });
  });

  describe('approve (atomic update & materialization)', () => {
    it('should throw ConflictException (409) if updateMany count is not 1 (concurrent approve/not SUBMITTED)', async () => {
      prisma.teamRegistration.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approve('reg-1', { reviewComment: 'OK' }, mockSuperAdminUser),
      ).rejects.toThrow(ConflictException);
    });

    it('should successfully approve and materialize profiles & players when status is SUBMITTED', async () => {
      prisma.teamRegistration.updateMany.mockResolvedValue({ count: 1 });
      prisma.teamRegistration.findUnique.mockResolvedValue({
        id: 'reg-1',
        seasonId: 'season-1',
        teamId: 'team-1',
        status: RegistrationStatus.APPROVED,
        teamData: {
          teamName: 'Alpha FC',
          teamDoctor: 'Dr. Smith',
          headCoach: 'Coach Joe',
          teamLeader: 'Leader Bob',
          coachPhone: '13800138000',
          leaderPhone: '13800138001',
          homeJerseyColor: 'RED',
          awayJerseyColor: 'WHITE',
          teamLogo: 'https://img/logo.jpg',
          homeJersey: 'https://img/home.jpg',
          awayJersey: 'https://img/away.jpg',
          gender: 'MALE',
        },
        players: [
          {
            playerId: 'player-existing-1',
            name: 'Existing P1',
            studentId: '20210001',
            jerseyNumber: '7',
            photo: null,
          },
          {
            playerId: null,
            name: 'Matched P2',
            studentId: '20210002',
            jerseyNumber: '10',
            photo: null,
          },
          {
            playerId: null,
            name: 'Brand New P3',
            studentId: '20210003',
            jerseyNumber: '11',
            photo: null,
          },
        ],
      });

      prisma.player.findFirst
        .mockResolvedValueOnce({ id: 'player-existing-1', teamId: 'team-1' })
        .mockResolvedValueOnce({ id: 'player-matched-2', teamId: 'team-1' })
        .mockResolvedValueOnce(null);

      prisma.player.create.mockResolvedValue({ id: 'player-new-3' });

      await service.approve('reg-1', { reviewComment: 'Approved!' }, mockSuperAdminUser);

      expect(prisma.seasonTeamProfile.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { seasonId_teamId: { seasonId: 'season-1', teamId: 'team-1' } },
          create: expect.objectContaining({ isRegistered: true, teamName: 'Alpha FC' }),
        }),
      );

      expect(teamRosterService.registerPlayer).toHaveBeenCalledTimes(3);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 10_000,
        timeout: 30_000,
      });
    });
  });

  describe('requestChanges (atomic update)', () => {
    it('should set status to CHANGES_REQUESTED using updateMany and write audit log', async () => {
      prisma.teamRegistration.updateMany.mockResolvedValue({ count: 1 });
      prisma.teamRegistration.findUnique.mockResolvedValue({
        id: 'reg-1',
        status: RegistrationStatus.CHANGES_REQUESTED,
        teamData: { teamName: 'Alpha FC' },
      });

      const res = await service.requestChanges(
        'reg-1',
        { reviewComment: 'Fix jersey numbers' },
        mockSuperAdminUser,
      );

      expect(res.status).toBe(RegistrationStatus.CHANGES_REQUESTED);
      expect(prisma.teamRegistration.updateMany).toHaveBeenCalledWith({
        where: { id: 'reg-1', status: RegistrationStatus.SUBMITTED },
        data: expect.objectContaining({
          status: RegistrationStatus.CHANGES_REQUESTED,
          reviewComment: 'Fix jersey numbers',
        }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('should throw ConflictException (409) if status is not SUBMITTED when requesting changes (updateMany count === 0)', async () => {
      prisma.teamRegistration.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.requestChanges('reg-1', { reviewComment: 'N/A' }, mockSuperAdminUser),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('getAdminList (summary masking)', () => {
    it('should query summary items and not return full players array', async () => {
      prisma.teamRegistration.count.mockResolvedValue(1);
      prisma.teamRegistration.findMany.mockResolvedValue([
        {
          id: 'reg-1',
          seasonId: 'season-1',
          teamId: 'team-1',
          status: RegistrationStatus.SUBMITTED,
          reviewComment: null,
          submittedAt: new Date(),
          reviewedAt: null,
          updatedAt: new Date(),
          teamData: { teamName: 'Alpha FC', gender: 'MALE', teamLogo: null },
          season: { name: '2026 Spring' },
          team: { teamName: 'Alpha FC' },
          _count: { players: 15 },
        },
      ]);

      const result = await service.getAdminList({ page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
      expect(result.items[0].playerCount).toBe(15);
      expect((result.items[0] as any).players).toBeUndefined();
    });
  });
});
