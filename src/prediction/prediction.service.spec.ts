import { Test, TestingModule } from '@nestjs/testing';
import { PredictionService, maskStudentId } from './prediction.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { PredictionChoice } from '@prisma/client';

describe('PredictionService & StudentId Masking', () => {
  let service: PredictionService;
  let prismaMock: any;
  let auditLogMock: any;

  beforeEach(async () => {
    prismaMock = {
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      match: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      season: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      prediction: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
    };
    prismaMock.$transaction = jest.fn(async (callback) => callback(prismaMock));

    auditLogMock = {
      log: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PredictionService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: auditLogMock },
      ],
    }).compile();

    service = module.get<PredictionService>(PredictionService);
  });

  describe('maskStudentId', () => {
    it('should mask student ID correctly', () => {
      expect(maskStudentId('2023123415')).toBe('2023****15');
      expect(maskStudentId('20230001')).toBe('2023****01');
      expect(maskStudentId(null)).toBe('未绑定');
      expect(maskStudentId('')).toBe('未绑定');
    });
  });

  describe('submitPrediction', () => {
    it('should throw ForbiddenException if user has no studentId', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        role: 'user',
        studentId: null,
      });

      await expect(service.submitPrediction('u1', 'm1', PredictionChoice.HOME_WIN)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw ForbiddenException if user is an admin account', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'admin1',
        role: 'super_admin',
        studentId: '2023999999',
      });

      await expect(
        service.submitPrediction('admin1', 'm1', PredictionChoice.HOME_WIN),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException if current time is past deadline (within 5 mins before match)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        role: 'user',
        studentId: '2023123456',
      });

      const matchDate = new Date(Date.now() + 3 * 60 * 1000);
      prismaMock.match.findUnique.mockResolvedValue({
        id: 'm1',
        status: 'scheduled',
        matchDate,
        deletedAt: null,
      });

      await expect(service.submitPrediction('u1', 'm1', PredictionChoice.HOME_WIN)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should allow prediction before deadline and upsert choice', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'u1',
        role: 'user',
        studentId: '2023123456',
      });

      const matchDate = new Date(Date.now() + 30 * 60 * 1000);
      prismaMock.match.findUnique.mockResolvedValue({
        id: 'm1',
        status: 'scheduled',
        matchDate,
        deletedAt: null,
      });

      prismaMock.prediction.upsert.mockResolvedValue({
        id: 'p1',
        userId: 'u1',
        matchId: 'm1',
        choice: PredictionChoice.HOME_WIN,
        status: 'PENDING',
      });

      const res = await service.submitPrediction('u1', 'm1', PredictionChoice.HOME_WIN);

      expect(res.choice).toBe(PredictionChoice.HOME_WIN);
      expect(prismaMock.prediction.upsert).toHaveBeenCalled();
    });
  });

  describe('settleMatchPredictions', () => {
    it('should calculate regular time score using lowercase event types ("goal", "penalty") and award 3 points for correct prediction', async () => {
      const match = {
        id: 'm1',
        deletedAt: null,
        homeScore: 2,
        awayScore: 1,
        events: [
          { eventType: 'goal', teamType: 'home', phase: 'REGULAR' },
          { eventType: 'penalty', teamType: 'home', phase: 'REGULAR' },
          { eventType: 'goal', teamType: 'away', phase: 'REGULAR' },
        ],
      };
      prismaMock.match.findUnique.mockResolvedValue(match);

      const predictions = [
        { id: 'p1', choice: PredictionChoice.HOME_WIN, status: 'PENDING' },
        { id: 'p2', choice: PredictionChoice.DRAW, status: 'PENDING' },
      ];
      prismaMock.prediction.findMany.mockResolvedValue(predictions);
      prismaMock.prediction.update.mockResolvedValue({});

      const result = await service.settleMatchPredictions('m1');

      expect(result.settledCount).toBe(2);
      expect(prismaMock.prediction.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: expect.objectContaining({
          status: 'CORRECT',
          awardedPoints: 3,
        }),
      });
      expect(prismaMock.prediction.update).toHaveBeenCalledWith({
        where: { id: 'p2' },
        data: expect.objectContaining({
          status: 'WRONG',
          awardedPoints: 0,
        }),
      });
    });

    it('should fallback to match.homeScore and match.awayScore if events only contain yellow_card', async () => {
      const match = {
        id: 'm2',
        deletedAt: null,
        homeScore: 2,
        awayScore: 1,
        events: [
          { eventType: 'yellow_card', teamType: 'home', phase: 'REGULAR' },
          { eventType: 'yellow_card', teamType: 'away', phase: 'REGULAR' },
        ],
      };
      prismaMock.match.findUnique.mockResolvedValue(match);

      const predictions = [{ id: 'p1', choice: PredictionChoice.HOME_WIN, status: 'PENDING' }];
      prismaMock.prediction.findMany.mockResolvedValue(predictions);
      prismaMock.prediction.update.mockResolvedValue({});

      const result = await service.settleMatchPredictions('m2');

      expect(result.settledCount).toBe(1);
      expect(prismaMock.prediction.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: expect.objectContaining({
          status: 'CORRECT',
          awardedPoints: 3,
        }),
      });
    });
  });

  describe('recalculateMatchPredictions', () => {
    it('should throw BadRequestException if match is not in finished status', async () => {
      prismaMock.match.findUnique.mockResolvedValue({
        id: 'm1',
        status: 'scheduled',
        homeTeam: { teamName: 'Home' },
        awayTeam: { teamName: 'Away' },
      });

      await expect(service.recalculateMatchPredictions('m1', 'admin')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should trigger settlement and log audit event when match is finished', async () => {
      prismaMock.match.findUnique.mockResolvedValue({
        id: 'm1',
        status: 'finished',
        homeScore: 1,
        awayScore: 0,
        events: [],
        homeTeam: { teamName: 'Home' },
        awayTeam: { teamName: 'Away' },
      });
      prismaMock.prediction.findMany.mockResolvedValue([]);

      const result = await service.recalculateMatchPredictions('m1', 'admin');

      expect(result.settledCount).toBe(0);
      expect(auditLogMock.log).toHaveBeenCalledWith(
        'admin',
        'RECALCULATE_PREDICTIONS',
        expect.stringContaining('Home vs Away'),
        prismaMock,
      );
    });
  });

  describe('voidMatchPredictions', () => {
    it('should return voidedCount 0 and message if all predictions are already voided', async () => {
      prismaMock.match.findUnique.mockResolvedValue({
        id: 'm1',
        status: 'cancelled',
        homeTeam: { teamName: 'Home' },
        awayTeam: { teamName: 'Away' },
      });
      prismaMock.prediction.count.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

      const res = await service.voidMatchPredictions('m1', 'admin');

      expect(res.voidedCount).toBe(0);
      expect(res.message).toBe('该比赛的所有竞猜已处于作废状态，无需重复作废');
    });
  });

  describe('getLeaderboard', () => {
    it('should fallback to active season when scope is season but seasonId is omitted', async () => {
      prismaMock.season.findFirst.mockResolvedValue({
        id: 'active-season-1',
        name: 'Active Season',
      });
      prismaMock.season.findUnique.mockResolvedValue({
        id: 'active-season-1',
        name: 'Active Season',
      });
      prismaMock.user.findMany.mockResolvedValue([]);

      const result = await service.getLeaderboard('season', '');
      expect(result).toEqual({ list: [], currentUser: null });
      expect(prismaMock.season.findFirst).toHaveBeenCalled();
    });

    it('should throw BadRequestException when seasonId does not exist', async () => {
      prismaMock.season.findUnique.mockResolvedValue(null);

      await expect(service.getLeaderboard('season', 'non-existing-season')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should handle tied rankings correctly and attach unranked currentUser', async () => {
      prismaMock.season.findUnique.mockResolvedValue({ id: 's1' });
      prismaMock.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          username: 'user1',
          nickname: 'User 1',
          studentId: '2023000001',
        },
        {
          id: 'u2',
          username: 'user2',
          nickname: 'User 2',
          studentId: '2023000002',
        },
      ]);
      prismaMock.prediction.findMany.mockResolvedValue([
        { userId: 'u1', status: 'CORRECT', awardedPoints: 3 },
        { userId: 'u2', status: 'CORRECT', awardedPoints: 3 },
      ]);

      const res = await service.getLeaderboard('season', 's1', 'u1');

      expect(res.list.length).toBe(2);
      expect(res.list[0].rank).toBe(1);
      expect(res.list[1].rank).toBe(1); // Tied rank
      expect(res.currentUser?.userId).toBe('u1');
    });
  });
});
