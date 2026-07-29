import { classifyBackupContent, MANDATORY_BACKUP_TABLES } from './backup-validator';
import * as crypto from 'crypto';

describe('BackupValidator Classifier & Integrty Test Suite', () => {
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

  it('应该将标准合规全量 17 表 V2 备份归类为 active', () => {
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
    const res = classifyBackupContent(str, 100, 50); // maxSizeBytes = 50
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
});
