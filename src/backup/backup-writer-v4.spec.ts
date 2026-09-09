import { Readable } from 'stream';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { BackupPlan } from './backup-plan.service';
import { createV4BackupStream } from './backup-writer';
import { BACKUP_MODULE_REGISTRY } from './backup-module-registry';
import { parseAndValidateBackupStream } from './backup-parser';
import { validateBackupStreamIntegrity } from './backup-validator';

async function consume(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('createV4BackupStream', () => {
  const seasonModule = BACKUP_MODULE_REGISTRY.season;
  const plan: BackupPlan = Object.freeze({
    scope: 'module',
    module: 'season',
    selector: Object.freeze({ seasonId: 'season-1' }),
    season: Object.freeze({ id: 'season-1', name: '第一赛季' }),
    tables: Object.freeze([
      ...seasonModule.ownedTables.map((tableName) =>
        Object.freeze({
          tableName,
          role: 'owned' as const,
          where: {},
          orderBy: { id: 'asc' as const },
        }),
      ),
      ...seasonModule.referenceTables.map((tableName) =>
        Object.freeze({
          tableName,
          role: 'reference' as const,
          where: {},
          orderBy: { id: 'asc' as const },
        }),
      ),
    ]),
    externalDependencies: Object.freeze(['User' as const, 'MemberAccount' as const]),
  });

  it('按执行计划输出 V4 表集合、角色和依赖摘要', async () => {
    const rows = {
      Season: [{ id: 'season-1', name: '第一赛季' }],
      Team: [{ id: 'team-1', name: '一队' }],
    } as const;
    const result = createV4BackupStream(
      plan,
      async function* (tableName) {
        yield (rows[tableName as keyof typeof rows] || []) as unknown as any[];
      },
      { createdAt: '2026-09-09T00:00:00.000Z' },
    );

    const compressed = await consume(result.stream);
    const json = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
    const manifest = await result.manifestPromise;

    expect(json.formatVersion).toBe('4.0');
    expect(Object.keys(json.tables)).toEqual(plan.tables.map(({ tableName }) => tableName));
    expect(manifest.tables.Season).toBe(1);
    expect(manifest.tables.Team).toBe(1);
    expect(manifest.tableRoles.Season).toBe('owned');
    expect(manifest.tableRoles.Team).toBe('reference');
    expect(manifest.externalDependencies).toEqual(['User', 'MemberAccount']);
    expect(manifest.selector).toEqual({ seasonId: 'season-1' });
    expect(manifest.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await result.checksumPromise).toBe(manifest.checksum);

    const expectedTablesJson = JSON.stringify(json.tables);
    expect(manifest.checksum).toBe(
      crypto.createHash('sha256').update(expectedTablesJson).digest('hex'),
    );

    const parsed = await parseAndValidateBackupStream(Readable.from(compressed));
    expect(() => validateBackupStreamIntegrity(parsed)).not.toThrow();
    expect(parsed.scope).toBe('module');
    expect((parsed.manifest as any).module).toBe('season');
    parsed.cleanup();
  });

  it('拒绝分页提供器返回非数组数据', async () => {
    const result = createV4BackupStream(plan, async function* () {
      yield null as any;
    });
    const checksumError = result.checksumPromise.catch((error) => error);
    const countsError = result.tableCountsPromise.catch((error) => error);
    const manifestError = result.manifestPromise.catch((error) => error);

    await expect(consume(result.stream)).rejects.toThrow('分页结果必须为数组');
    expect(await checksumError).toBeInstanceOf(TypeError);
    expect(await countsError).toBeInstanceOf(TypeError);
    expect(await manifestError).toBeInstanceOf(TypeError);
  });
});
