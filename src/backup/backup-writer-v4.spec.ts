import { Readable } from 'stream';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { BackupPlan } from './backup-plan.service';
import { createV4BackupStream } from './backup-writer';

async function consume(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('createV4BackupStream', () => {
  const plan: BackupPlan = Object.freeze({
    scope: 'module',
    module: 'season',
    selector: Object.freeze({ seasonId: 'season-1' }),
    season: Object.freeze({ id: 'season-1', name: '第一赛季' }),
    tables: Object.freeze([
      Object.freeze({
        tableName: 'Season',
        role: 'owned',
        where: {},
        orderBy: { id: 'asc' as const },
      }),
      Object.freeze({
        tableName: 'Team',
        role: 'reference',
        where: {},
        orderBy: { id: 'asc' as const },
      }),
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
        yield rows[tableName as keyof typeof rows] as unknown as any[];
      },
      { createdAt: '2026-09-09T00:00:00.000Z' },
    );

    const json = JSON.parse(zlib.gunzipSync(await consume(result.stream)).toString('utf8'));
    const manifest = await result.manifestPromise;

    expect(json.formatVersion).toBe('4.0');
    expect(Object.keys(json.tables)).toEqual(['Season', 'Team']);
    expect(manifest.tables).toEqual({ Season: 1, Team: 1 });
    expect(manifest.tableRoles).toEqual({ Season: 'owned', Team: 'reference' });
    expect(manifest.externalDependencies).toEqual(['User', 'MemberAccount']);
    expect(manifest.selector).toEqual({ seasonId: 'season-1' });
    expect(manifest.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await result.checksumPromise).toBe(manifest.checksum);

    const expectedTablesJson = JSON.stringify(json.tables);
    expect(manifest.checksum).toBe(
      crypto.createHash('sha256').update(expectedTablesJson).digest('hex'),
    );
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
