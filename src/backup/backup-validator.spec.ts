import {
  classifyBackupContent,
  MANDATORY_BACKUP_TABLES,
  LEGACY_V3_REQUIRED_TABLES,
  EXCLUDED_BACKUP_MODELS,
  V4_PERSISTENT_MODELS,
  validateBackupStreamIntegrity,
} from './backup-validator';
import {
  MandatoryBackupTableName,
  TABLE_METADATA_MAP,
  LEGACY_V3_RESTORE_DELETE_ORDER,
  RESTORE_DELETE_ORDER,
} from './backup-table-registry';
import { parseAndValidateBackupStream, createV3BackupStream } from './backup-serializer';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

describe('BackupValidator Classifier & Integrity Test Suite', () => {
  const buildValidV2 = () => {
    const tables: Record<string, any[]> = {};
    for (const t of MANDATORY_BACKUP_TABLES) {
      tables[t] = [];
    }
    tables.User = [{ id: 'u1', username: 'admin', role: 'super_admin' }];
    tables.Team = [{ id: 't1', teamName: '计算机系' }];
    tables.Player = [
      { id: 'p1', name: '张三', studentId: '20260001', jerseyNumber: '10', teamId: 't1' },
    ];
    tables.Season = [{ id: 's1', name: '2026超级联赛' }];
    tables.Match = [
      {
        id: 'm1',
        homeTeamId: 't1',
        awayTeamId: 't1',
        seasonId: 's1',
        matchDate: '2026-05-01T10:00:00.000Z',
        location: '球场',
      },
    ];

    const tableCounts: Record<string, number> = {};
    for (const t of MANDATORY_BACKUP_TABLES) {
      tableCounts[t] = tables[t].length;
    }

    const checksum = crypto.createHash('sha256').update(JSON.stringify(tables)).digest('hex');
    return {
      formatVersion: '2.0',
      manifest: {
        checksumAlgorithm: 'sha256',
        checksum,
        tables: tableCounts,
      },
      tables,
    };
  };

  it('应该将标准合规全量 18 表 V2 备份归类为 active', () => {
    const validData = buildValidV2();
    const str = JSON.stringify(validData);
    const res = classifyBackupContent(str, Buffer.byteLength(str));
    expect(res.category).toBe('active');
  });

  it('应该将旧版 V1 备份归类为 legacy-archive', () => {
    const legacyData = { formatVersion: '1.0', tables: {} };
    const str = JSON.stringify(legacyData);
    const res = classifyBackupContent(str, Buffer.byteLength(str));
    expect(res.category).toBe('legacy-archive');
  });

  it('应该将非法 JSON 字符串归类为 quarantine', () => {
    const invalidJson = '{ bad_json: ';
    const res = classifyBackupContent(invalidJson, Buffer.byteLength(invalidJson));
    expect(res.category).toBe('quarantine');
    expect(res.reason).toMatch(/JSON 语法解析失败/);
  });

  it('应该将超限大文件归类为 quarantine', () => {
    const str = 'a'.repeat(100);
    const res = classifyBackupContent(str, 100, 50);
    expect(res.category).toBe('quarantine');
    expect(res.reason).toMatch(/超过最大允许上限/);
  });

  it('应该将缺失必要表计数的伪造 V2 归类为 quarantine', () => {
    const invalidV2 = buildValidV2();
    delete (invalidV2.manifest.tables as any).Match;
    const str = JSON.stringify(invalidV2);
    const res = classifyBackupContent(str, Buffer.byteLength(str));
    expect(res.category).toBe('quarantine');
    expect(res.reason).toMatch(/V2 校验拦截/);
  });

  it('应该将 Manifest 计数与实际数组不符的伪造 V2 归类为 quarantine', () => {
    const invalidV2 = buildValidV2();
    invalidV2.manifest.tables.User = 999;
    const str = JSON.stringify(invalidV2);
    const res = classifyBackupContent(str, Buffer.byteLength(str));
    expect(res.category).toBe('quarantine');
    expect(res.reason).toMatch(/计数不匹配/);
  });

  it('应该将 SHA-256 摘要不匹配的损坏 V2 归类为 quarantine', () => {
    const invalidV2 = buildValidV2();
    invalidV2.manifest.checksum = '0'.repeat(64);
    const str = JSON.stringify(invalidV2);
    const res = classifyBackupContent(str, Buffer.byteLength(str));
    expect(res.category).toBe('quarantine');
    expect(res.reason).toMatch(/SHA-256 Mismatch/);
  });

  it('应该将包含无效外键（Goal.matchId 引用不存在的比赛）的 V2 归类为 quarantine', () => {
    const v2 = buildValidV2();
    v2.tables.Goal = [{ id: 'g1', matchId: 'non_existent_match', playerId: 'p1' }];
    v2.manifest.tables.Goal = 1;
    v2.manifest.checksum = crypto
      .createHash('sha256')
      .update(JSON.stringify(v2.tables))
      .digest('hex');
    const str = JSON.stringify(v2);
    const res = classifyBackupContent(str, Buffer.byteLength(str));
    expect(res.category).toBe('quarantine');
    expect(res.reason).toMatch(/引用了不存在的比赛 ID/);
  });

  it('应该将包含重复复合唯一键（Prediction 重复 userId+matchId）的 V2 归类为 quarantine', () => {
    const v2 = buildValidV2();
    v2.tables.MemberAccount = [{ id: 'u1', username: 'student' }];
    v2.manifest.tables.MemberAccount = 1;
    v2.tables.Prediction = [
      { id: 'pr1', userId: 'u1', matchId: 'm1' },
      { id: 'pr2', userId: 'u1', matchId: 'm1' },
    ];
    v2.manifest.tables.Prediction = 2;
    v2.manifest.checksum = crypto
      .createHash('sha256')
      .update(JSON.stringify(v2.tables))
      .digest('hex');
    const str = JSON.stringify(v2);
    const res = classifyBackupContent(str, Buffer.byteLength(str));
    expect(res.category).toBe('quarantine');
    expect(res.reason).toMatch(/重复的复合唯一键/);
  });

  it('应该将包含非法 ISO 日期字段的 V2 归类为 quarantine', () => {
    const v2 = buildValidV2();
    v2.tables.User[0].createdAt = 'invalid-date-string';
    v2.manifest.checksum = crypto
      .createHash('sha256')
      .update(JSON.stringify(v2.tables))
      .digest('hex');
    const str = JSON.stringify(v2);
    const res = classifyBackupContent(str, Buffer.byteLength(str));
    expect(res.category).toBe('quarantine');
    expect(res.reason).toMatch(/包含无效日期值/);
  });

  describe('增量 Checksum 字节序列与格式兼容性测试', () => {
    it('对于包含中文、emoji、转义字符与嵌套 JSON 的多表数据，增量算出的 Checksum 必须与 sha256(JSON.stringify(tables)) 完全一致', async () => {
      const sampleTables: Record<string, any[]> = {};
      for (const t of MANDATORY_BACKUP_TABLES) {
        sampleTables[t] = [];
      }
      sampleTables.User = [
        {
          id: 'u_101',
          username: '测试管理员 ⚽ 🔥',
          bio: 'Line1\nLine2\t"Quotes" \\ Special chars',
          settings: { theme: 'dark', notifications: { email: true } },
        },
      ];

      const expectedChecksum = crypto
        .createHash('sha256')
        .update(JSON.stringify(sampleTables))
        .digest('hex');

      const pageProvider = (tableName: MandatoryBackupTableName) => {
        return (async function* () {
          yield sampleTables[tableName];
        })();
      };

      const { stream, checksumPromise } = createV3BackupStream(pageProvider);
      const parseResult = await parseAndValidateBackupStream(stream, 'test.json.gz');

      expect(parseResult.computedChecksum).toBe(expectedChecksum);
      expect(await checksumPromise).toBe(expectedChecksum);
      expect(Object.keys(parseResult.tableCounts)).toEqual(MANDATORY_BACKUP_TABLES);
      for (const tableName of MANDATORY_BACKUP_TABLES) {
        expect(parseResult.tableCounts[tableName]).toBe(sampleTables[tableName].length);
      }
      expect(() => validateBackupStreamIntegrity(parseResult)).not.toThrow();

      parseResult.cleanup();
    });

    it('单条记录解析前，当单个字符串 Token 超过 BACKUP_MAX_RECORD_BYTES 时，必须在组装对象前触发早期拦截并彻底清理资源', async () => {
      const origMax = process.env.BACKUP_MAX_RECORD_BYTES;
      process.env.BACKUP_MAX_RECORD_BYTES = '100'; // 100 字节极小阈值

      const hugeString = 'A'.repeat(500); // 500 字节远超 100 字节
      const sampleTables: Record<string, any[]> = {};
      for (const t of MANDATORY_BACKUP_TABLES) {
        sampleTables[t] = [];
      }
      sampleTables.User = [{ id: 'u1', huge: hugeString }];

      const jsonStr = JSON.stringify({ formatVersion: '3.0', tables: sampleTables });
      const stream = Readable.from([jsonStr]);

      const parseResult: any = null;
      try {
        await parseAndValidateBackupStream(stream, 'oversized.json');
        fail('应当抛出单条记录超限异常');
      } catch (err: any) {
        expect(err.message).toMatch(/超出单条记录最大允许上限/);
      } finally {
        if (parseResult) parseResult.cleanup();
        process.env.BACKUP_MAX_RECORD_BYTES = origMax;
      }
    });
  });

  describe('24-Model 分类完整性与排他性守卫', () => {
    it('Prisma Schema 中的所有 Model 必须被精确且无交集地分类为 22 个 V4 持久业务表和 2 个排除表', () => {
      const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
      const schemaContent = fs.readFileSync(schemaPath, 'utf8');

      // 提取 prisma 中的所有 model 声明
      const modelRegex = /^model\s+(\w+)\s+\{/gm;
      const schemaModels = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = modelRegex.exec(schemaContent)) !== null) {
        schemaModels.add(match[1]);
      }

      expect(schemaModels.size).toBe(24);

      const persistentSet = new Set<string>(V4_PERSISTENT_MODELS);
      const excludedSet = new Set<string>(EXCLUDED_BACKUP_MODELS);

      expect(persistentSet.size).toBe(22);
      expect(excludedSet.size).toBe(2);

      // 交集必须为空
      const intersection = [...persistentSet].filter((x) => excludedSet.has(x));
      expect(intersection).toEqual([]);

      // 并集必须完全覆盖 schema 中的 24 个 model
      const union = new Set<string>([...persistentSet, ...excludedSet]);
      expect(union).toEqual(schemaModels);

      // TABLE_METADATA_MAP 必须完整包含全部 22 个持久业务表
      for (const table of V4_PERSISTENT_MODELS) {
        expect(TABLE_METADATA_MAP[table]).toBeDefined();
        expect(TABLE_METADATA_MAP[table].tableName).toBe(table);
      }
    });

    it('历史 V3 恢复顺序必须冻结在 18 表，绝不包含新增的 4 张表', () => {
      expect(LEGACY_V3_RESTORE_DELETE_ORDER).toHaveLength(18);
      expect(RESTORE_DELETE_ORDER).toEqual(LEGACY_V3_RESTORE_DELETE_ORDER);

      const unbackedTables = [
        'AdminFormDraft',
        'TeamRegistration',
        'RegistrationTeamData',
        'RegistrationPlayer',
      ];

      for (const table of unbackedTables) {
        expect(LEGACY_V3_RESTORE_DELETE_ORDER).not.toContain(table);
        expect(RESTORE_DELETE_ORDER).not.toContain(table);
      }
    });
  });

  describe('排除表（CampusCardAsset, AuthRateLimit）多层拦截测试', () => {
    it('当内存 JSON 备份中包含排除表时，必须归类为 quarantine 并明确拒绝', () => {
      for (const excluded of EXCLUDED_BACKUP_MODELS) {
        const v2 = buildValidV2();
        (v2.tables as any)[excluded] = [{ id: 'bad_1' }];
        (v2.manifest.tables as any)[excluded] = 1;
        v2.manifest.checksum = crypto
          .createHash('sha256')
          .update(JSON.stringify(v2.tables))
          .digest('hex');

        const str = JSON.stringify(v2);
        const res = classifyBackupContent(str, Buffer.byteLength(str));
        expect(res.category).toBe('quarantine');
        expect(res.reason).toMatch(/包含禁止备份的安全敏感或临时表/);
      }
    });

    it('当流式 NDJSON 解析遇到排除表时，流式解析器必须 fail-closed 拦截并抛出具体异常', async () => {
      for (const excluded of EXCLUDED_BACKUP_MODELS) {
        const payload: Record<string, any> = {};
        for (const t of LEGACY_V3_REQUIRED_TABLES) {
          payload[t] = [];
        }
        payload[excluded] = [{ id: 'bad_row' }];

        const jsonStr = JSON.stringify({ formatVersion: '3.0', tables: payload });
        const stream = Readable.from([jsonStr]);

        let parseResult: any = null;
        try {
          parseResult = await parseAndValidateBackupStream(stream, 'excluded.json');
          fail(`应当拦截排除表: ${excluded}`);
        } catch (err: any) {
          expect(err.message).toMatch(/包含禁止备份的安全敏感或临时表/);
        } finally {
          if (parseResult) parseResult.cleanup();
        }
      }
    });
  });
});
