import { Readable } from 'stream';
import { executeMigrationMachine } from '../../scripts/migrate-old-backups-core';
import { MANDATORY_BACKUP_TABLES } from './backup-validator';
import * as crypto from 'crypto';

describe('MigrateOldBackups State Machine Core Unit Test Suite', () => {
  let mockS3Client: any;

  const buildValidV2Json = () => {
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
    return JSON.stringify({
      formatVersion: '2.0',
      manifest: {
        checksumAlgorithm: 'sha256',
        checksum,
        tables: tableCounts,
      },
      tables,
    });
  };

  const buildV1Json = () => JSON.stringify({ formatVersion: '1.0', tables: {} });
  const buildCorruptedJson = () => JSON.stringify({ formatVersion: '2.0', tables: {} }); // 缺 manifest

  beforeEach(() => {
    mockS3Client = {
      send: jest.fn(),
    };
  });

  it('Dry-run 模式：应该准确预审分类对象去向，且不触发 Copy 或 Delete', async () => {
    mockS3Client.send.mockImplementation(async (command: any) => {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return {
          Contents: [
            { Key: 'backups/v2_valid.json', Size: 100 },
            { Key: 'backups/v1_old.json', Size: 50 },
            { Key: 'backups/v2_bad.json', Size: 80 },
          ],
        };
      }
      if (name === 'GetObjectCommand') {
        if (command.input.Key === 'backups/v2_valid.json') {
          return { Body: Readable.from([Buffer.from(buildValidV2Json())]) };
        }
        if (command.input.Key === 'backups/v1_old.json') {
          return { Body: Readable.from([Buffer.from(buildV1Json())]) };
        }
        if (command.input.Key === 'backups/v2_bad.json') {
          return { Body: Readable.from([Buffer.from(buildCorruptedJson())]) };
        }
      }
      return {};
    });

    const result = await executeMigrationMachine(mockS3Client, 'test-bucket', {
      isDryRun: true,
      isCopy: false,
      isVerify: false,
      isDeleteSource: false,
      confirmDeleteText: '',
    });

    expect(result.sourceObjects.length).toBe(3);
    expect(result.classifications['backups/v2_valid.json'].targetKey).toBe(
      'private-backups/database/v2_valid.json',
    );
    expect(result.classifications['backups/v2_valid.json'].category).toBe('active');

    expect(result.classifications['backups/v1_old.json'].targetKey).toBe(
      'private-backups/legacy-archive/v1_old.json',
    );
    expect(result.classifications['backups/v1_old.json'].category).toBe('legacy-archive');

    expect(result.classifications['backups/v2_bad.json'].targetKey).toBe(
      'private-backups/quarantine/v2_bad.json',
    );
    expect(result.classifications['backups/v2_bad.json'].category).toBe('quarantine');
  });

  it('--copy 阶段：当目标已存在但 SHA-256 哈希不符合时，应该抛错拒绝覆盖', async () => {
    mockS3Client.send.mockImplementation(async (command: any) => {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'backups/v2_valid.json', Size: 100 }] };
      }
      if (name === 'GetObjectCommand') {
        if (command.input.Key === 'backups/v2_valid.json') {
          return { Body: Readable.from([Buffer.from(buildValidV2Json())]) };
        }
        if (command.input.Key === 'private-backups/database/v2_valid.json') {
          // 返回内容不同导致 SHA-256 冲突
          return {
            Body: Readable.from([
              Buffer.from(JSON.stringify({ formatVersion: '2.0', diff: true })),
            ]),
          };
        }
      }
      return {};
    });

    await expect(
      executeMigrationMachine(mockS3Client, 'test-bucket', {
        isDryRun: false,
        isCopy: true,
        isVerify: false,
        isDeleteSource: false,
        confirmDeleteText: '',
      }),
    ).rejects.toThrow(/禁止静默覆盖/);
  });

  it('--delete-source 阶段：未传入正确的确认文本时，应该拦截抛错', async () => {
    await expect(
      executeMigrationMachine(mockS3Client, 'test-bucket', {
        isDryRun: false,
        isCopy: false,
        isVerify: true,
        isDeleteSource: true,
        confirmDeleteText: 'WRONG_TEXT',
      }),
    ).rejects.toThrow(/删除源对象缺少显式确认文本/);
    expect(mockS3Client.send).not.toHaveBeenCalled();
  });

  it('超限对象：超过 50MB 上限的对象应该被归类为 quarantine，且使用无截断的 fullSize', async () => {
    const bigContent = 'x'.repeat(200);
    mockS3Client.send.mockImplementation(async (command: any) => {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'backups/big.json', Size: 200 }] };
      }
      if (name === 'GetObjectCommand') {
        return { Body: Readable.from([Buffer.from(bigContent)]) };
      }
      return {};
    });

    const result = await executeMigrationMachine(mockS3Client, 'test-bucket', {
      isDryRun: true,
      isCopy: false,
      isVerify: false,
      isDeleteSource: false,
      confirmDeleteText: '',
      maxSizeBytes: 50, // 设上限为 50 字节
    });

    expect(result.classifications['backups/big.json'].category).toBe('quarantine');
    expect(result.classifications['backups/big.json'].targetKey).toBe(
      'private-backups/quarantine/big.json',
    );
    expect(result.classifications['backups/big.json'].size).toBe(200); // fullSize === 200
  });

  it('--copy --verify：复制后应该使用源对象完整内容通过摘要与体积校验', async () => {
    const sourceKey = 'backups/v2_valid.json';
    const targetKey = 'private-backups/database/v2_valid.json';
    const sourceContent = buildValidV2Json();
    let targetContent: string | undefined;

    mockS3Client.send.mockImplementation(async (command: any) => {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: sourceKey, Size: Buffer.byteLength(sourceContent) }] };
      }
      if (name === 'GetObjectCommand') {
        if (command.input.Key === sourceKey) {
          return { Body: Readable.from([Buffer.from(sourceContent)]) };
        }
        if (command.input.Key === targetKey && targetContent !== undefined) {
          return { Body: Readable.from([Buffer.from(targetContent)]) };
        }
        const error: any = new Error('NoSuchKey');
        error.name = 'NoSuchKey';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      if (name === 'CopyObjectCommand') {
        targetContent = sourceContent;
        return {};
      }
      return {};
    });

    const result = await executeMigrationMachine(mockS3Client, 'test-bucket', {
      isDryRun: false,
      isCopy: true,
      isVerify: true,
      isDeleteSource: false,
      confirmDeleteText: '',
    });

    expect(result.success).toBe(true);
    expect(targetContent).toBe(sourceContent);
    expect(
      mockS3Client.send.mock.calls.some(
        ([command]: any[]) => command.constructor.name === 'CopyObjectCommand',
      ),
    ).toBe(true);
  });

  it('目标摘要相同时应该跳过 CopyObjectCommand', async () => {
    const content = buildValidV2Json();
    mockS3Client.send.mockImplementation(async (command: any) => {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'backups/v2_valid.json', Size: Buffer.byteLength(content) }] };
      }
      if (command.constructor.name === 'GetObjectCommand') {
        return { Body: Readable.from([Buffer.from(content)]) };
      }
      return {};
    });

    await executeMigrationMachine(mockS3Client, 'test-bucket', {
      isDryRun: false,
      isCopy: true,
      isVerify: false,
      isDeleteSource: false,
      confirmDeleteText: '',
    });

    expect(
      mockS3Client.send.mock.calls.some(
        ([command]: any[]) => command.constructor.name === 'CopyObjectCommand',
      ),
    ).toBe(false);
  });

  it('目标缺失或摘要错误时应该在删除源对象前失败', async () => {
    const content = buildValidV2Json();
    mockS3Client.send.mockImplementation(async (command: any) => {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'backups/v2_valid.json', Size: Buffer.byteLength(content) }] };
      }
      if (
        command.constructor.name === 'GetObjectCommand' &&
        command.input.Key === 'backups/v2_valid.json'
      ) {
        return { Body: Readable.from([Buffer.from(content)]) };
      }
      const error: any = new Error('NoSuchKey');
      error.name = 'NoSuchKey';
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    });

    await expect(
      executeMigrationMachine(mockS3Client, 'test-bucket', {
        isDryRun: false,
        isCopy: false,
        isVerify: false,
        isDeleteSource: true,
        confirmDeleteText: 'DELETE_VERIFIED_OLD_BACKUPS',
      }),
    ).rejects.toThrow(/拒绝执行源文件删除/);
    expect(
      mockS3Client.send.mock.calls.some(
        ([command]: any[]) => command.constructor.name === 'DeleteObjectCommand',
      ),
    ).toBe(false);
  });

  it('正确确认且校验成功后才删除，并通过 HeadObject 404 确认消失', async () => {
    const content = buildValidV2Json();
    let deleted = false;
    mockS3Client.send.mockImplementation(async (command: any) => {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'backups/v2_valid.json', Size: Buffer.byteLength(content) }] };
      }
      if (name === 'GetObjectCommand') {
        return { Body: Readable.from([Buffer.from(content)]) };
      }
      if (name === 'DeleteObjectCommand') {
        deleted = true;
        return {};
      }
      if (name === 'HeadObjectCommand' && deleted) {
        const error: any = new Error('NotFound');
        error.name = 'NotFound';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {};
    });

    const result = await executeMigrationMachine(mockS3Client, 'test-bucket', {
      isDryRun: false,
      isCopy: false,
      isVerify: false,
      isDeleteSource: true,
      confirmDeleteText: 'DELETE_VERIFIED_OLD_BACKUPS',
    });

    expect(result.success).toBe(true);
    expect(deleted).toBe(true);
  });

  it('删除后 HeadObject 仍能读取源对象时必须失败', async () => {
    const content = buildValidV2Json();
    mockS3Client.send.mockImplementation(async (command: any) => {
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'backups/v2_valid.json', Size: Buffer.byteLength(content) }] };
      }
      if (command.constructor.name === 'GetObjectCommand') {
        return { Body: Readable.from([Buffer.from(content)]) };
      }
      return {};
    });

    await expect(
      executeMigrationMachine(mockS3Client, 'test-bucket', {
        isDryRun: false,
        isCopy: false,
        isVerify: false,
        isDeleteSource: true,
        confirmDeleteText: 'DELETE_VERIFIED_OLD_BACKUPS',
      }),
    ).rejects.toThrow(/源对象仍存在/);
  });

  it('应该跟随 ContinuationToken 合并所有分页对象', async () => {
    const first = buildV1Json();
    const second = buildV1Json();
    mockS3Client.send.mockImplementation(async (command: any) => {
      if (command.constructor.name === 'ListObjectsV2Command') {
        if (!command.input.ContinuationToken) {
          return {
            Contents: [{ Key: 'backups/page1.json', Size: Buffer.byteLength(first) }],
            NextContinuationToken: 'next-page',
          };
        }
        return {
          Contents: [{ Key: 'backups/page2.json', Size: Buffer.byteLength(second) }],
        };
      }
      if (command.constructor.name === 'GetObjectCommand') {
        const content = command.input.Key.endsWith('page1.json') ? first : second;
        return { Body: Readable.from([Buffer.from(content)]) };
      }
      return {};
    });

    const result = await executeMigrationMachine(mockS3Client, 'test-bucket', {
      isDryRun: true,
      isCopy: false,
      isVerify: false,
      isDeleteSource: false,
      confirmDeleteText: '',
    });

    expect(result.sourceObjects.map((item) => item.Key)).toEqual([
      'backups/page1.json',
      'backups/page2.json',
    ]);
  });

  it('CopySource 应该编码空格、井号、百分号和中文，同时保留路径分隔符', async () => {
    const sourceKey = 'backups/赛 程#100%.json';
    const content = buildV1Json();
    let copySource = '';
    mockS3Client.send.mockImplementation(async (command: any) => {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: sourceKey, Size: Buffer.byteLength(content) }] };
      }
      if (name === 'GetObjectCommand' && command.input.Key === sourceKey) {
        return { Body: Readable.from([Buffer.from(content)]) };
      }
      if (name === 'GetObjectCommand') {
        const error: any = new Error('NoSuchKey');
        error.name = 'NoSuchKey';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      if (name === 'CopyObjectCommand') {
        copySource = command.input.CopySource;
        return {};
      }
      return {};
    });

    await executeMigrationMachine(mockS3Client, 'test-bucket', {
      isDryRun: false,
      isCopy: true,
      isVerify: false,
      isDeleteSource: false,
      confirmDeleteText: '',
    });

    expect(copySource).toBe('test-bucket/backups/%E8%B5%9B%20%E7%A8%8B%23100%25.json');
  });
});
