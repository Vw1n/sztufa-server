import { BadRequestException } from '@nestjs/common';
import { ImportService } from './import.service';

const counts = {
  seasons: 1,
  teams: 2,
  players: 1,
  matches: 1,
  events: 1,
};

const historyDocument = {
  schemaVersion: 2,
  season: { name: '2023 校长杯' },
  teams: [
    {
      name: '甲队',
      players: [
        {
          name: '张三',
          jerseyNumbers: ['9'],
        },
      ],
    },
    { name: '乙队', players: [] },
  ],
  matches: [
    {
      gameId: '2023-01',
      date: '2023年3月1日',
      time: '18:30',
      round: '小组赛 A组',
      group: 'A',
      homeTeam: '甲队',
      awayTeam: '乙队',
      homeScore: 1,
      awayScore: 0,
      penaltyShootout: null,
      events: [
        {
          eventId: 'event-1',
          time: '12',
          eventType: '进球',
          teamType: 'home',
          teamName: '甲队',
          playerName: '张三',
          jerseyNumber: '9',
        },
      ],
    },
  ],
};

const asUpload = (
  name: string,
  document: Record<string, unknown> = historyDocument,
): Express.Multer.File => {
  const buffer = Buffer.from(JSON.stringify(document), 'utf8');
  return {
    fieldname: 'files',
    originalname: name,
    encoding: '7bit',
    mimetype: 'application/json',
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
};

const createReadPrisma = () => ({
  season: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  team: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  player: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  match: {
    findMany: jest.fn().mockResolvedValue([]),
  },
});

const createService = (prisma: any) =>
  new ImportService(prisma, { computeAndCache: jest.fn() } as any, { log: jest.fn() } as any);

describe('ImportService', () => {
  it('预检分赛季文件并统计所有可导入实体', async () => {
    const prisma = createReadPrisma();
    const preview = await createService(prisma).previewFiles([asUpload('2023.json')]);

    expect(preview.canImport).toBe(true);
    expect(preview.records).toEqual(counts);
    expect(preview.create).toEqual(counts);
    expect(preview.update).toEqual({
      seasons: 0,
      teams: 0,
      players: 0,
      matches: 0,
      events: 0,
    });
    expect(preview.files).toEqual([{ name: '2023.json', type: 'season', season: '2023 校长杯' }]);
    expect(preview.warnings[0]).toContain('HIST-');
  });

  it('把同名人工球员和同一历史比赛识别为覆盖更新', async () => {
    const prisma = createReadPrisma();
    prisma.season.findMany.mockResolvedValue([{ name: '2023 校长杯' }]);
    prisma.team.findMany.mockResolvedValue([{ teamName: '甲队' }, { teamName: '乙队' }]);
    prisma.player.findMany.mockResolvedValue([
      { legacyKey: null, name: '张三', team: { teamName: '甲队' } },
    ]);
    prisma.match.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve([{ legacyGameId: where.legacyGameId.in[0] }]),
    );

    const preview = await createService(prisma).previewFiles([asUpload('2023.json')]);

    expect(preview.create).toEqual({
      seasons: 0,
      teams: 0,
      players: 0,
      matches: 0,
      events: 0,
    });
    expect(preview.update).toEqual(counts);
  });

  it('拒绝在同一批次中重复上传同一赛季', async () => {
    const prisma = createReadPrisma();
    const preview = await createService(prisma).previewFiles([
      asUpload('2023-a.json'),
      asUpload('2023-b.json'),
    ]);

    expect(preview.canImport).toBe(false);
    expect(preview.errors).toContain('2023-b.json: 赛季 2023 校长杯 重复上传');
    expect(prisma.season.findMany).not.toHaveBeenCalled();
  });

  it('摘要变化时在开启事务前中止导入', async () => {
    const prisma = {
      ...createReadPrisma(),
      $transaction: jest.fn(),
    };

    await expect(
      createService(prisma).importFiles([asUpload('2023.json')], 'admin', 'old-digest'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('在一个事务中创建赛季、球队、球员、比赛及事件', async () => {
    const tx = {
      season: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'season-1' }),
      },
      team: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: any) =>
          Promise.resolve({ id: data.teamName === '甲队' ? 'team-a' : 'team-b' }),
        ),
      },
      player: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'player-1' }),
      },
      seasonTeamPlayer: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      match: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'match-1' }),
      },
      goal: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      matchEvent: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      ...createReadPrisma(),
      $transaction: jest.fn((work: (client: typeof tx) => Promise<void>) => work(tx)),
    };
    (prisma.season as any).findUnique = jest.fn().mockResolvedValue({ id: 'season-1' });
    const seasonStatistics = {
      computeAndCache: jest.fn().mockResolvedValue({ success: true }),
    };
    const auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new ImportService(prisma as any, seasonStatistics as any, auditLog as any);

    const result = await service.importFiles([asUpload('2023.json')], 'admin');

    expect(result.created).toEqual(counts);
    expect(tx.player.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: '张三',
        studentId: expect.stringMatching(/^HIST-[A-F0-9]{16}$/),
        photo: null,
      }),
    });
    expect(tx.match.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        legacyGameId: expect.stringMatching(/^history:/),
        status: 'finished',
        stage: 'GROUP',
        groupName: 'A',
        homeScore: 1,
        awayScore: 0,
      }),
    });
    expect(tx.matchEvent.createMany).toHaveBeenCalledTimes(1);
    expect(tx.goal.createMany).toHaveBeenCalledTimes(1);
    expect(seasonStatistics.computeAndCache).toHaveBeenCalledWith('season-1');
    expect(auditLog.log).toHaveBeenCalledWith(
      'admin',
      'IMPORT_HISTORY_JSON',
      expect.stringContaining('1 场比赛'),
      tx,
    );
  });
});
