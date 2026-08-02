import { BadRequestException } from '@nestjs/common';
import { ImportService } from './import.service';

const counts = {
  seasons: 1,
  teams: 2,
  players: 1,
  matches: 1,
  events: 2,
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
      penaltyShootout: {
        homeScore: null,
        awayScore: null,
        kicks: [
          {
            eventId: 'shootout-1',
            teamType: 'home',
            playerName: '张三',
            jerseyNumber: '9',
            scored: true,
            round: 1,
            order: 1,
          },
        ],
      },
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

  it('把相同赛季的历史球员和历史比赛识别为覆盖更新', async () => {
    const prisma = createReadPrisma();
    prisma.season.findMany.mockResolvedValue([{ name: '2023 校长杯' }]);
    prisma.team.findMany.mockResolvedValue([{ teamName: '甲队' }, { teamName: '乙队' }]);
    prisma.player.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve([{ legacyKey: where.legacyKey.in[0] }]),
    );
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

  it('为不同赛季的同名球队和同名球员创建独立球员记录', async () => {
    const prisma = createReadPrisma();
    const secondSeasonDocument = {
      ...historyDocument,
      season: { name: '2024 校长杯' },
    };

    const preview = await createService(prisma).previewFiles([
      asUpload('2023.json'),
      asUpload('2024.json', secondSeasonDocument),
    ]);

    expect(preview.canImport).toBe(true);
    expect(preview.records).toEqual({
      seasons: 2,
      teams: 2,
      players: 2,
      matches: 2,
      events: 4,
    });
    const playerQuery = prisma.player.findMany.mock.calls[0][0];
    expect(new Set(playerQuery.where.legacyKey.in).size).toBe(2);
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
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'roster-1' }),
      },
      seasonTeamProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'profile-1' }),
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
      historyImportBatch: {
        create: jest.fn().mockResolvedValue({ id: 'batch-1' }),
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
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 15_000,
      timeout: 240_000,
    });
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
    expect(tx.matchEvent.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          eventType: 'penalty_shootout_goal',
          phase: 'SHOOTOUT',
          shootoutRound: 1,
          shootoutOrder: 1,
        }),
      ]),
    });
    expect(tx.goal.createMany).toHaveBeenCalledTimes(1);
    expect(tx.historyImportBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        digest: expect.any(String),
        username: 'admin',
        undoPayload: expect.objectContaining({
          created: expect.objectContaining({
            seasonIds: ['season-1'],
            playerIds: ['player-1'],
            matchIds: ['match-1'],
          }),
        }),
      }),
    });
    expect(tx.seasonTeamProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          seasonId: 'season-1',
          teamName: '甲队',
          headCoach: null,
          teamLogo: null,
        }),
      }),
    );
    expect(seasonStatistics.computeAndCache).toHaveBeenCalledWith('season-1');
    expect(auditLog.log).toHaveBeenCalledWith(
      'admin',
      'IMPORT_HISTORY_JSON',
      expect.stringContaining('1 场比赛'),
      tx,
    );
  });

  it('在一个事务中撤销最近一次导入批次', async () => {
    const undoPayload = {
      affectedSeasonIds: ['season-1'],
      created: {
        seasonIds: ['season-1'],
        teamIds: ['team-a'],
        profileIds: ['profile-1'],
        playerIds: ['player-1'],
        rosterLinkIds: ['roster-1'],
        matchIds: ['match-1'],
      },
      updated: {
        teams: [],
        players: [],
        rosterLinks: [],
        matches: [],
      },
    };
    const tx = {
      match: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      seasonTeamPlayer: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      seasonTeamProfile: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      player: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      team: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      season: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      historyImportBatch: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      historyImportBatch: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'batch-1',
          undoPayload,
        }),
      },
      season: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((work: (client: typeof tx) => Promise<void>) => work(tx)),
    };
    const auditLog = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new ImportService(
      prisma as any,
      { computeAndCache: jest.fn() } as any,
      auditLog as any,
    );

    await expect(service.undoLastImport('admin')).resolves.toEqual({
      batchId: 'batch-1',
      affectedSeasons: 1,
      restoredMatches: 0,
      deletedMatches: 1,
      restoredPlayers: 0,
      deletedPlayers: 1,
      warnings: [],
    });
    expect(tx.match.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['match-1'] } } });
    expect(tx.historyImportBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { status: 'undone', undoneAt: expect.any(Date) },
    });
    expect(auditLog.log).toHaveBeenCalledWith(
      'admin',
      'UNDO_HISTORY_JSON_IMPORT',
      '撤销历史 JSON 导入批次 batch-1',
      tx,
    );
  });
});
