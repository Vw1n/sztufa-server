import { BadRequestException } from '@nestjs/common';
import { BackupFingerprintService } from './backup-fingerprint.service';
import { PrismaService } from '../prisma/prisma.service';

describe('BackupFingerprintService', () => {
  let service: BackupFingerprintService;
  let mockPrisma: any;

  const createMockDelegate = (
    options: {
      count?: number;
      maxUpdatedAt?: Date | null;
      minUpdatedAt?: Date | null;
      maxId?: string | null;
      minId?: string | null;
      deletedCount?: number;
      lineupRows?: any[];
      maxUndoneAt?: Date | null;
    } = {},
  ) => {
    return {
      aggregate: jest.fn().mockImplementation((args: any) => {
        if (args._max?.undoneAt) {
          return Promise.resolve({
            _max: { undoneAt: options.maxUndoneAt ?? null },
          });
        }
        return Promise.resolve({
          _count: { _all: options.count ?? 5 },
          _max: {
            id: options.maxId ?? 'id_999',
            updatedAt:
              options.maxUpdatedAt !== undefined
                ? options.maxUpdatedAt
                : new Date('2026-09-10T12:00:00.000Z'),
            createdAt:
              options.maxUpdatedAt !== undefined
                ? options.maxUpdatedAt
                : new Date('2026-09-10T12:00:00.000Z'),
          },
          _min: {
            id: options.minId ?? 'id_001',
            updatedAt:
              options.minUpdatedAt !== undefined
                ? options.minUpdatedAt
                : new Date('2026-09-10T10:00:00.000Z'),
            createdAt:
              options.minUpdatedAt !== undefined
                ? options.minUpdatedAt
                : new Date('2026-09-10T10:00:00.000Z'),
          },
        });
      }),
      count: jest.fn().mockResolvedValue(options.deletedCount ?? 1),
      findMany: jest.fn().mockResolvedValue(
        options.lineupRows ?? [
          {
            id: 'l1',
            matchId: 'm1',
            playerId: 'p1',
            teamType: 'HOME',
            lineupType: 'STARTING',
          },
        ],
      ),
    };
  };

  const setupService = (delegateOverrides: Record<string, any> = {}) => {
    const defaultDelegate = createMockDelegate();
    mockPrisma = new Proxy(
      {},
      {
        get: (target: any, prop: string) => {
          if (prop in delegateOverrides) {
            return delegateOverrides[prop];
          }
          return defaultDelegate;
        },
      },
    );
    service = new BackupFingerprintService(mockPrisma as unknown as PrismaService);
  };

  beforeEach(() => {
    setupService();
  });

  describe('1. 规范化选择器与锁键校验', () => {
    it('season 模块缺少 seasonId 时必须抛出 BadRequestException', async () => {
      await expect(service.calculateModuleFingerprint('season')).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.calculateModuleFingerprint('season', { seasonId: '   ' }),
      ).rejects.toThrow('赛季模块备份必须指定 seasonId');
    });

    it('非 season 模块无需 seasonId 即可计算', async () => {
      const res = await service.calculateModuleFingerprint('staff');
      expect(res.module).toBe('staff');
      expect(res.selectorKey).toBe('staff');
      expect(res.fingerprint).toBeDefined();
    });
  });

  describe('2. 真实业务数据变更与指纹敏锐度', () => {
    it('无任何数据变动时，多次计算的指纹完全相同 (确定性输出)', async () => {
      const res1 = await service.calculateModuleFingerprint('season', { seasonId: 's1' });
      const res2 = await service.calculateModuleFingerprint('season', { seasonId: 's1' });
      expect(res1.fingerprint).toBe(res2.fingerprint);
    });

    it('行数发生变化（物理删除或新增数据）时，指纹必定变化', async () => {
      const res1 = await service.calculateModuleFingerprint('season', { seasonId: 's1' });

      // 模拟 Match 表删除了一行记录，导致 rowCount 从 5 变成 4
      setupService({
        match: createMockDelegate({ count: 4 }),
      });
      const res2 = await service.calculateModuleFingerprint('season', { seasonId: 's1' });

      expect(res1.fingerprint).not.toBe(res2.fingerprint);
    });

    it('原有数据被更新（updatedAt 推进）时，指纹必定变化', async () => {
      const initialDate = new Date('2026-09-10T12:00:00.000Z');
      const updatedDate = new Date('2026-09-10T12:05:00.000Z');

      setupService({
        season: createMockDelegate({ maxUpdatedAt: initialDate }),
      });
      const res1 = await service.calculateModuleFingerprint('season', { seasonId: 's1' });

      setupService({
        season: createMockDelegate({ maxUpdatedAt: updatedDate }),
      });
      const res2 = await service.calculateModuleFingerprint('season', { seasonId: 's1' });

      expect(res1.fingerprint).not.toBe(res2.fingerprint);
    });

    it('软删除标记（deletedAt 状态改变）时，指纹必定变化', async () => {
      setupService({
        match: createMockDelegate({ deletedCount: 0 }),
      });
      const res1 = await service.calculateModuleFingerprint('season', { seasonId: 's1' });

      setupService({
        match: createMockDelegate({ deletedCount: 1 }),
      });
      const res2 = await service.calculateModuleFingerprint('season', { seasonId: 's1' });

      expect(res1.fingerprint).not.toBe(res2.fingerprint);
    });

    it('MatchLineup 首发/替补或球员替换（轻量投影哈希）变化时，指纹必定变化', async () => {
      setupService({
        matchLineup: createMockDelegate({
          lineupRows: [
            { id: 'l1', matchId: 'm1', playerId: 'p1', teamType: 'HOME', lineupType: 'STARTING' },
          ],
        }),
      });
      const res1 = await service.calculateModuleFingerprint('season', { seasonId: 's1' });

      // 球员从首发变为替补，总记录数和时间均未变化
      setupService({
        matchLineup: createMockDelegate({
          lineupRows: [
            { id: 'l1', matchId: 'm1', playerId: 'p1', teamType: 'HOME', lineupType: 'BENCH' },
          ],
        }),
      });
      const res2 = await service.calculateModuleFingerprint('season', { seasonId: 's1' });

      expect(res1.fingerprint).not.toBe(res2.fingerprint);
    });

    it('HistoryImportBatch 状态撤销（undoneAt 赋值）时，指纹必定变化', async () => {
      setupService({
        historyImportBatch: createMockDelegate({ maxUndoneAt: null }),
      });
      const res1 = await service.calculateModuleFingerprint('operations');

      setupService({
        historyImportBatch: createMockDelegate({
          maxUndoneAt: new Date('2026-09-10T15:00:00.000Z'),
        }),
      });
      const res2 = await service.calculateModuleFingerprint('operations');

      expect(res1.fingerprint).not.toBe(res2.fingerprint);
    });
  });

  describe('3. clock_timestamp 原生触发器长事务更新防漏检场景验证', () => {
    it('长事务启动时间早于当前表 max(updatedAt) 时，clock_timestamp 保证获得最新真实时刻，指纹必定改变', async () => {
      // 场景设定：
      // 表中现有最新 updatedAt 为 10:05:00
      const currentMaxInDb = new Date('2026-09-10T10:05:00.000Z');
      setupService({
        season: createMockDelegate({ maxUpdatedAt: currentMaxInDb }),
      });
      const baseline = await service.calculateModuleFingerprint('season', { seasonId: 's1' });

      // 若使用 PostgreSQL 的 CURRENT_TIMESTAMP，长事务在 10:00:00 开启，10:10:00 更新，
      // CURRENT_TIMESTAMP 会返回事务开始时间 10:00:00，导致 max(updatedAt) 仍为 10:05:00，漏检！
      // 迁移触发器中采用 clock_timestamp()，更新时写入真实系统时间 10:10:00：
      const actualExecutionTimestamp = new Date('2026-09-10T10:10:00.000Z');
      setupService({
        season: createMockDelegate({ maxUpdatedAt: actualExecutionTimestamp }),
      });
      const afterUpdate = await service.calculateModuleFingerprint('season', { seasonId: 's1' });

      expect(afterUpdate.fingerprint).not.toBe(baseline.fingerprint);
      const seasonTableFp = afterUpdate.tableFingerprints.find((t) => t.table === 'Season');
      expect(seasonTableFp?.maxUpdatedAt).toBe('2026-09-10T10:10:00.000Z');
    });
  });

  describe('4. 慢查询耗时预警保护', () => {
    it('当指纹计算耗时大于 500ms 时触发 Logger.warn 记录慢日志', async () => {
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

      // 模拟计算耗时
      const realNow = Date.now;
      let callCount = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 1000 : 1600; // 600ms > 500ms
      });

      await service.calculateModuleFingerprint('staff');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FingerprintSlowQuery] staff:staff 指纹计算耗时 600ms'),
      );

      Date.now = realNow;
    });
  });
});
