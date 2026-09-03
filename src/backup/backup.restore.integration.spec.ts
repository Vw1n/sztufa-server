import { PrismaClient } from '@prisma/client';
import { BackupService, MANDATORY_BACKUP_TABLES } from './backup.service';
import { BackupRetentionService } from './backup-retention.service';
import { BackupScopeService } from './backup-scope.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupExportService } from './backup-export.service';
import { BackupRestoreService } from './backup-restore.service';
import { BackupUploadService } from './backup-upload.service';
import { BackupMaintenanceService } from './backup-maintenance.service';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';
import { Readable } from 'stream';

describe('Backup & Restore Real PostgreSQL Integration Spec', () => {
  let testPrisma: PrismaClient;
  let service: BackupService;
  let objectStore: BackupObjectStoreService;
  let mockAuditLog: any;
  let originalBackupRestoreEnabled: string | undefined;

  beforeAll(async () => {
    // 强制要求 TEST_DATABASE_URL 环境变量存在，否则终止整个集成测试套件
    const testDbUrl = process.env.TEST_DATABASE_URL;
    if (!testDbUrl) {
      throw new Error(
        '[FATAL INTEGRATION ERROR] 未配置 TEST_DATABASE_URL！恢复集成测试要求连接真实 PostgreSQL 测试数据库（数据库名必须以 _test 结尾）。',
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(testDbUrl);
    } catch {
      throw new Error(`[FATAL INTEGRATION ERROR] TEST_DATABASE_URL 格式非法: ${testDbUrl}`);
    }

    const dbName = parsedUrl.pathname.replace(/^\//, '');
    const allowedHosts = (process.env.ALLOWED_TEST_DB_HOSTS || 'localhost,127.0.0.1,postgres,db')
      .split(',')
      .map((h) => h.trim());

    if (!dbName.endsWith('_test')) {
      throw new Error(
        `[FATAL INTEGRATION ERROR] 测试数据库名称必须以 _test 结尾，当前为: ${dbName}`,
      );
    }

    if (!allowedHosts.includes(parsedUrl.hostname)) {
      throw new Error(
        `[FATAL INTEGRATION ERROR] 测试数据库 Host (${parsedUrl.hostname}) 不在白名单 (${allowedHosts.join(', ')}) 中！`,
      );
    }

    testPrisma = new PrismaClient({
      datasources: {
        db: {
          url: testDbUrl,
        },
      },
    });

    await testPrisma.$connect();

    mockAuditLog = {
      log: jest.fn().mockResolvedValue(true),
    };

    const retentionService = new BackupRetentionService();
    const scopeService = new BackupScopeService(testPrisma as unknown as PrismaService);
    objectStore = new BackupObjectStoreService();
    const verificationService = new BackupVerificationService(objectStore);
    const exportService = new BackupExportService(
      testPrisma as unknown as PrismaService,
      objectStore,
      verificationService,
      mockAuditLog as any,
      scopeService,
    );
    const restoreService = new BackupRestoreService(
      testPrisma as unknown as PrismaService,
      objectStore,
      verificationService,
      exportService,
      mockAuditLog as any,
    );
    const uploadService = new BackupUploadService(objectStore, verificationService, mockAuditLog);
    const maintenanceService = new BackupMaintenanceService(
      objectStore,
      verificationService,
      retentionService,
      mockAuditLog,
    );
    service = new BackupService(
      exportService,
      restoreService,
      uploadService,
      maintenanceService,
      objectStore,
      verificationService,
      scopeService,
      retentionService,
      testPrisma as unknown as PrismaService,
    );

    // 保存原始值并启用恢复功能（所有集成测试均需要）
    originalBackupRestoreEnabled = process.env.BACKUP_RESTORE_ENABLED;
    process.env.BACKUP_RESTORE_ENABLED = 'true';
  });

  afterAll(async () => {
    // 恢复 BACKUP_RESTORE_ENABLED 原始值
    if (originalBackupRestoreEnabled === undefined) {
      delete process.env.BACKUP_RESTORE_ENABLED;
    } else {
      process.env.BACKUP_RESTORE_ENABLED = originalBackupRestoreEnabled;
    }

    if (testPrisma) {
      await testPrisma.$disconnect();
    }
  });

  /**
   * 18 表全局规范化快照计算工具
   * 逐表读取记录，对 ID 排序与 Date 字符串化，计算全库 18 表确定性 SHA-256 摘要与快照结构
   */
  const compute18TableSnapshot = async (prisma: PrismaClient) => {
    const snapshot: Record<string, any[]> = {};
    const counts: Record<string, number> = {};

    for (const t of MANDATORY_BACKUP_TABLES) {
      const modelName = (t.charAt(0).toLowerCase() + t.slice(1)) as keyof PrismaClient;
      let rows: any[] = [];
      if (typeof (prisma[modelName] as any)?.findMany === 'function') {
        rows = await (prisma[modelName] as any).findMany();
      }

      // 对行数据按 id 规范化排序，对 Date 统一转 ISO 字符串
      const normalizedRows = rows
        .map((row) => {
          const norm: Record<string, any> = {};
          for (const key of Object.keys(row).sort()) {
            const val = row[key];
            if (val instanceof Date) {
              norm[key] = val.toISOString();
            } else {
              norm[key] = val;
            }
          }
          return norm;
        })
        .sort((a, b) => (a.id || '').localeCompare(b.id || ''));

      snapshot[t] = normalizedRows;
      counts[t] = normalizedRows.length;
    }

    const hash = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

    return { snapshot, counts, hash };
  };

  /** 清理全库 18 表数据 */
  const clearAll18Tables = async (prisma: PrismaClient) => {
    await prisma.match.updateMany({ data: { mvpPlayerId: null } });
    await prisma.player.updateMany({ data: { suspendedAtMatchId: null } });
    await prisma.user.updateMany({ data: { teamId: null } });

    for (const t of [...MANDATORY_BACKUP_TABLES].reverse()) {
      const modelName = (t.charAt(0).toLowerCase() + t.slice(1)) as keyof PrismaClient;
      if (typeof (prisma[modelName] as any)?.deleteMany === 'function') {
        await (prisma[modelName] as any).deleteMany();
      }
    }
  };

  /** 向全库 18 表真实填充至少一条合规记录 */
  const seedAll18Tables = async (prisma: PrismaClient) => {
    await clearAll18Tables(prisma);

    const user1 = await prisma.user.create({
      data: { id: 'u1', username: 'admin', password: 'hashed_pwd_123', role: 'super_admin' },
    });
    const member1 = await prisma.memberAccount.create({
      data: {
        id: 'member1',
        username: 'member_fixture',
        password: 'hashed_member_pwd',
        verificationStatus: 'APPROVED',
      },
    });
    await prisma.user.create({
      data: { id: 'u2', username: 'coach1', password: 'hashed_pwd_456', role: 'coach' },
    });

    const team1 = await prisma.team.create({
      data: {
        id: 't1',
        teamName: '计算机系队',
        coachPhone: '13800138000',
        leaderPhone: '13900139000',
        homeJerseyColor: '红色',
        awayJerseyColor: '白色',
        gender: 'MALE',
      },
    });

    const player1 = await prisma.player.create({
      data: {
        id: 'p1',
        name: '张三',
        studentId: '20260001',
        jerseyNumber: '10',
        teamId: team1.id,
        status: 'active',
        yellowCards: 0,
        redCards: 0,
      },
    });

    const season1 = await prisma.season.create({
      data: {
        id: 's1',
        name: '2026超级联赛',
        status: 'active',
        type: 'LEAGUE',
      },
    });

    const match1 = await prisma.match.create({
      data: {
        id: 'm1',
        seasonId: season1.id,
        homeTeamId: team1.id,
        awayTeamId: team1.id,
        homeScore: 1,
        awayScore: 0,
        matchDate: new Date('2026-05-01T10:00:00Z'),
        location: '北区足球场',
        status: 'scheduled',
        stage: 'LEAGUE',
        groupName: 'A组',
        mvpPlayerId: player1.id,
      },
    });

    await prisma.prediction.create({
      data: {
        id: 'pred1',
        userId: member1.id,
        matchId: match1.id,
        choice: 'HOME_WIN',
        status: 'PENDING',
        awardedPoints: 0,
      },
    });

    await prisma.goal.create({
      data: {
        id: 'g1',
        matchId: match1.id,
        playerId: player1.id,
        playerName: '张三',
        jerseyNumber: '10',
        goalTime: "15'",
        teamType: 'home',
      },
    });

    await prisma.matchEvent.create({
      data: {
        id: 'e1',
        matchId: match1.id,
        eventTime: "30'",
        eventType: 'YELLOW_CARD',
        phase: 'REGULAR',
        playerId: player1.id,
        description: '黄牌警告',
        teamType: 'home',
      },
    });

    await prisma.news.create({
      data: {
        id: 'n1',
        title: '揭幕战捷报',
        category: 'ANNOUNCEMENT',
        content: '计算机系队取得开门红',
        description: '摘要描述',
        published: true,
        publishedAt: new Date('2026-05-01T12:00:00Z'),
        date: '2026-05-01',
      },
    });

    await prisma.auditLog.create({
      data: {
        id: 'log1',
        username: 'admin',
        action: 'CREATE_MATCH',
        details: '创建比赛 m1',
        createdAt: new Date('2026-05-01T09:00:00Z'),
      },
    });

    await prisma.seasonTeamProfile.create({
      data: {
        id: 'stp1',
        seasonId: season1.id,
        teamId: team1.id,
        teamName: '计算机系队',
        homeJerseyColor: '红色',
        awayJerseyColor: '白色',
        gender: 'MALE',
      },
    });

    await prisma.historyImportBatch.create({
      data: {
        id: 'hib1',
        digest: 'sha256_hash_str',
        username: 'admin',
        status: 'completed',
        summary: {},
        undoPayload: {},
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    await prisma.seasonDeletionApproval.create({
      data: {
        id: 'sda1',
        seasonId: season1.id,
        approverId: user1.id,
        createdAt: new Date('2026-05-01T00:00:00Z'),
      },
    });

    await prisma.seasonTeamPlayer.create({
      data: {
        id: 'stp_p1',
        seasonId: season1.id,
        teamId: team1.id,
        playerId: player1.id,
        studentId: player1.studentId,
        playerName: '张三',
        jerseyNumber: '10',
      },
    });

    await prisma.matchLineup.create({
      data: {
        id: 'ml1',
        matchId: match1.id,
        playerId: player1.id,
        teamType: 'home',
        lineupType: 'starting',
      },
    });

    await prisma.seasonGroupTeam.create({
      data: {
        id: 'sgt1',
        seasonId: season1.id,
        teamId: team1.id,
        groupName: 'A组',
      },
    });

    await prisma.pdfImportBatch.create({
      data: {
        id: 'pib1',
        fileHash: 'hash123',
        username: 'admin',
        status: 'COMMITTED',
        expiresAt: new Date('2026-06-01T00:00:00Z'),
      },
    });
  };

  describe('PostgreSQL 真实 pg_try_advisory_xact_lock 事务锁互斥测试', () => {
    it('当已有事务持有 Advisory Lock 88998899 时，并发恢复请求应该被拒', async () => {
      const secondClient = new PrismaClient({
        datasources: {
          db: {
            url: process.env.TEST_DATABASE_URL,
          },
        },
      });
      await secondClient.$connect();

      try {
        await testPrisma.$transaction(async (tx1) => {
          const [{ locked: lock1 }] = await tx1.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(88998899) AS locked`;
          expect(lock1).toBe(true);

          await secondClient.$transaction(async (tx2) => {
            const [{ locked: lock2 }] = await tx2.$queryRaw<
              { locked: boolean }[]
            >`SELECT pg_try_advisory_xact_lock(88998899) AS locked`;
            expect(lock2).toBe(false);
          });
        });
      } finally {
        await secondClient.$disconnect();
      }
    });
  });

  describe('PostgreSQL 真实数据库全量 18 表导出、篡改、恢复与深度数据一致性测试', () => {
    it('应该能够在真实 PostgreSQL 中向 18 张表写入数据，执行真实 createBackup，篡改库后 restoreBackup 恢复全量 18 表深度相等', async () => {
      // 1. 真实向全库 18 张表写入至少 1 条数据
      await seedAll18Tables(testPrisma);

      // 2. 测量导出前全库 18 表规范化快照与 SHA-256 摘要
      const preExportSnapshot = await compute18TableSnapshot(testPrisma);

      // 验证 18 张表每张都有真实记录
      for (const tableName of MANDATORY_BACKUP_TABLES) {
        expect(preExportSnapshot.counts[tableName]).toBeGreaterThanOrEqual(1);
      }

      // 3. 拦截 S3 客户端，捕获真实 createBackup 导出的全量 GZIP 管道流
      let capturedBackupBuffer: Buffer = Buffer.alloc(0);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const UploadMock = require('@aws-sdk/lib-storage').Upload;
      jest.spyOn(UploadMock.prototype, 'done').mockImplementation(async function (this: any) {
        const stream = this.params.Body;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }
        capturedBackupBuffer = Buffer.concat(chunks);
        return { Location: 'mock-location' } as any;
      });

      jest.spyOn((objectStore as any).s3Client, 'send').mockImplementation(async (command: any) => {
        if (command.constructor.name === 'GetObjectCommand') {
          return { Body: Readable.from([capturedBackupBuffer]) } as any;
        }
        return {} as any;
      });

      // 执行真实 createBackup 导出
      const backupInfo = await service.createBackup('admin');
      expect(backupInfo.key).toMatch(/^private-backups\/database\/full\/backup_/);
      expect(capturedBackupBuffer.length).toBeGreaterThan(0);

      // 4. 彻底篡改数据库全量 18 表记录与关系
      await testPrisma.match.updateMany({ data: { mvpPlayerId: null } });
      await testPrisma.goal.deleteMany();
      await testPrisma.matchEvent.deleteMany();
      await testPrisma.matchLineup.deleteMany();
      await testPrisma.prediction.deleteMany();
      await testPrisma.seasonTeamPlayer.deleteMany();
      await testPrisma.seasonTeamProfile.deleteMany();
      await testPrisma.seasonGroupTeam.deleteMany();
      await testPrisma.seasonDeletionApproval.deleteMany();
      await testPrisma.historyImportBatch.deleteMany();
      await testPrisma.pdfImportBatch.deleteMany();
      await testPrisma.news.updateMany({ data: { title: '被篡改的标题' } });
      await testPrisma.auditLog.updateMany({ data: { details: '被篡改的日志' } });
      await testPrisma.user.update({ where: { id: 'u1' }, data: { username: 'corrupted_user_1' } });
      await testPrisma.user.update({ where: { id: 'u2' }, data: { username: 'corrupted_user_2' } });
      await testPrisma.memberAccount.update({
        where: { id: 'member1' },
        data: { username: 'corrupted_member' },
      });

      const corruptedSnapshot = await compute18TableSnapshot(testPrisma);
      expect(corruptedSnapshot.hash).not.toBe(preExportSnapshot.hash);

      // 5. 执行 restoreBackup 恢复
      const restoreEpoch = Math.floor(Date.now() / 1000);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(restoreEpoch * 1000);
      let restoreResult: string;
      try {
        restoreResult = await service.restoreBackup('admin', backupInfo.key, 'CONFIRM_RESTORE');
      } finally {
        clock.mockRestore();
      }
      expect(restoreResult).toBe('数据库还原成功');

      // 6. 测量恢复后全库 18 表规范化快照并做 100% 深度相等断言
      const postRestoreSnapshot = await compute18TableSnapshot(testPrisma);

      expect(postRestoreSnapshot.counts).toEqual(preExportSnapshot.counts);
      // 恢复必须撤销旧会话：仅 sessionVersion 按明确规则变化，其余字段仍深度相等。
      const expectedSnapshot = JSON.parse(JSON.stringify(preExportSnapshot.snapshot));
      for (const table of ['User', 'MemberAccount']) {
        for (const row of expectedSnapshot[table]) row.sessionVersion = restoreEpoch;
      }
      expect(postRestoreSnapshot.snapshot).toEqual(expectedSnapshot);
      expect(postRestoreSnapshot.hash).toBe(
        crypto.createHash('sha256').update(JSON.stringify(expectedSnapshot)).digest('hex'),
      );

      // 7. 关键外键关系单独校验
      const restoredMatch = await testPrisma.match.findUnique({ where: { id: 'm1' } });
      expect(restoredMatch?.mvpPlayerId).toBe('p1');

      const restoredPred = await testPrisma.prediction.findUnique({ where: { id: 'pred1' } });
      expect(restoredPred?.userId).toBe('member1');
      expect(restoredPred?.matchId).toBe('m1');

      const restoredLineup = await testPrisma.matchLineup.findUnique({ where: { id: 'ml1' } });
      expect(restoredLineup?.matchId).toBe('m1');
      expect(restoredLineup?.playerId).toBe('p1');

      const restoredApproval = await testPrisma.seasonDeletionApproval.findUnique({
        where: { id: 'sda1' },
      });
      expect(restoredApproval?.approverId).toBe('u1');
      expect(restoredApproval?.seasonId).toBe('s1');
    });

    it('当还原在 PostgreSQL 清库/写入事务末端触发写入异常时，整个 18 表事务必须完整回滚，全库 18 表快照摘要保持 100% 不变', async () => {
      // 1. 确保已有合规测试数据
      await seedAll18Tables(testPrisma);
      const preFailSnapshot = await compute18TableSnapshot(testPrisma);

      // 2. 捕获真实 gzip backup buffer，保证 parseAndValidateBackupStream 能正确解析
      let capturedRollbackBuffer: Buffer = Buffer.alloc(0);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const UploadMockRollback = require('@aws-sdk/lib-storage').Upload;
      jest.spyOn(UploadMockRollback.prototype, 'done').mockImplementation(async function (
        this: any,
      ) {
        const stream = this.params.Body;
        if (!capturedRollbackBuffer.length) {
          // 首次调用：捕获主备份 gzip buffer
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          capturedRollbackBuffer = Buffer.concat(chunks);
        }
        return { Location: 'mock-location-rollback' } as any;
      });

      jest.spyOn((objectStore as any).s3Client, 'send').mockImplementation(async (command: any) => {
        if (command.constructor.name === 'GetObjectCommand') {
          return { Body: Readable.from([capturedRollbackBuffer]) } as any;
        }
        return {} as any;
      });

      await service.createBackup('admin');

      // 3. 监控 testPrisma.$transaction 确保真实进入数据库事务
      let transactionEntered = false;
      const originalTransaction = testPrisma.$transaction.bind(testPrisma);
      jest.spyOn(testPrisma, '$transaction').mockImplementation(async (cb: any, options: any) => {
        transactionEntered = true;
        return originalTransaction(async (tx: any) => {
          // 包装 tx.pdfImportBatch.createMany，在最后阶段抛出模拟数据库底层写入异常
          const originalCreateMany = tx.pdfImportBatch.createMany.bind(tx.pdfImportBatch);
          tx.pdfImportBatch.createMany = async (...args: any[]) => {
            await originalCreateMany(...args);
            throw new Error('[DB INTEGRATION TEST] 模拟数据库事务末端写入异常，触发 DB 事务回滚');
          };
          return cb(tx);
        }, options);
      });

      // 4. 执行 restoreBackup，断言抛出事务末端异常
      await expect(
        service.restoreBackup(
          'admin',
          'private-backups/database/backup_conflict.json',
          'CONFIRM_RESTORE',
        ),
      ).rejects.toThrow(/模拟数据库事务末端写入异常/);

      // 5. 明确断言确实进入了 $transaction 事务
      expect(transactionEntered).toBe(true);

      // 6. 断言 PostgreSQL 事务成功进行全表回滚：测算恢复失败后的全库 18 表快照摘要，必须与 preFailSnapshot 100% 深度相等！
      const postFailSnapshot = await compute18TableSnapshot(testPrisma);
      expect(postFailSnapshot.hash).toBe(preFailSnapshot.hash);
      expect(postFailSnapshot.snapshot).toEqual(preFailSnapshot.snapshot);
    });

    it('当数据库中存在报名记录时，执行旧 V3 恢复必须被前置守卫拒绝拦截，且数据库数据保持原样', async () => {
      // 1. 确保已有合规测试数据
      await seedAll18Tables(testPrisma);
      const preSnapshot = await compute18TableSnapshot(testPrisma);

      // 2. 插入一条 TeamRegistration 记录
      await testPrisma.teamRegistration.create({
        data: {
          id: 'reg_test_1',
          seasonId: 's1',
          teamId: 't1',
          submittedById: 'u1',
          status: 'DRAFT',
        },
      });

      // 3. 执行旧版 V3 恢复，断言被前置拦截
      await expect(
        service.restoreBackup(
          'admin',
          'private-backups/database/full/backup_v3.json.gz',
          'CONFIRM_RESTORE',
        ),
      ).rejects.toThrow(/已存在 1 条报名记录（TeamRegistration）/);

      // 4. 清理创建的测试报名记录后，全库数据应与 preSnapshot 一致
      await testPrisma.teamRegistration.deleteMany({ where: { id: 'reg_test_1' } });
      const postSnapshot = await compute18TableSnapshot(testPrisma);
      expect(postSnapshot.hash).toBe(preSnapshot.hash);
    });
  });
});
