import { KnockoutGeneratorService } from './knockout-generator.service';

describe('KnockoutGeneratorService', () => {
  const prisma = {
    season: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const auditLogService = { log: jest.fn() };
  let service: KnockoutGeneratorService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new KnockoutGeneratorService(prisma as any, auditLogService as any);
  });

  it('非杯赛(CUP)类型赛季生成淘汰赛对阵时抛出 BadRequestException', async () => {
    prisma.season.findUnique.mockResolvedValue({ id: 's1', type: 'LEAGUE' });
    await expect(service.generateKnockoutMatches('s1', 'admin')).rejects.toThrow(
      '该赛季不是杯赛，无法生成淘汰赛对阵',
    );
  });

  it('缺乏小组赛积分榜缓存时抛出 BadRequestException', async () => {
    prisma.season.findUnique.mockResolvedValue({ id: 's1', type: 'CUP', standingsCache: null });
    await expect(service.generateKnockoutMatches('s1', 'admin')).rejects.toThrow(
      '未找到小组赛积分缓存',
    );
  });

  it('支持 8 个小组 (A-H) 提取出线队并自动生成 16 强 (R16) 对阵', async () => {
    const mockStandingsCache = {
      groups: {
        A: [{ teamId: 'team-A1' }, { teamId: 'team-A2' }],
        B: [{ teamId: 'team-B1' }, { teamId: 'team-B2' }],
        C: [{ teamId: 'team-C1' }, { teamId: 'team-C2' }],
        D: [{ teamId: 'team-D1' }, { teamId: 'team-D2' }],
        E: [{ teamId: 'team-E1' }, { teamId: 'team-E2' }],
        F: [{ teamId: 'team-F1' }, { teamId: 'team-F2' }],
        G: [{ teamId: 'team-G1' }, { teamId: 'team-G2' }],
        H: [{ teamId: 'team-H1' }, { teamId: 'team-H2' }],
      },
    };

    prisma.season.findUnique.mockResolvedValue({
      id: 's1',
      type: 'CUP',
      standingsCache: mockStandingsCache,
    });

    const tx = {
      match: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'm1' }),
        update: jest.fn(),
      },
    };

    prisma.$transaction.mockImplementation(async (cb: (client: typeof tx) => unknown) => cb(tx));

    const result = await service.generateKnockoutMatches('s1', 'admin');
    expect(result.success).toBe(true);
    expect(result.round).toBe('R16');
    expect(result.countCreated).toBe(8);
    expect(tx.match.create).toHaveBeenCalledTimes(8);
    expect(auditLogService.log).toHaveBeenCalledWith(
      'admin',
      'GENERATE_KNOCKOUT_MATCHES',
      expect.stringContaining('轮次: R16'),
    );
  });

  it('支持 4 个小组 (A-D) 提取出线队并自动生成 8 强 (QF) 对阵', async () => {
    const mockStandingsCache = {
      groups: {
        A: [{ teamId: 'team-A1' }, { teamId: 'team-A2' }],
        B: [{ teamId: 'team-B1' }, { teamId: 'team-B2' }],
        C: [{ teamId: 'team-C1' }, { teamId: 'team-C2' }],
        D: [{ teamId: 'team-D1' }, { teamId: 'team-D2' }],
      },
    };

    prisma.season.findUnique.mockResolvedValue({
      id: 's1',
      type: 'CUP',
      standingsCache: mockStandingsCache,
    });

    const tx = {
      match: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'm1' }),
        update: jest.fn(),
      },
    };

    prisma.$transaction.mockImplementation(async (cb: (client: typeof tx) => unknown) => cb(tx));

    const result = await service.generateKnockoutMatches('s1', 'admin');
    expect(result.success).toBe(true);
    expect(result.round).toBe('QF');
    expect(result.countCreated).toBe(4);
    expect(tx.match.create).toHaveBeenCalledTimes(4);
    expect(auditLogService.log).toHaveBeenCalledWith(
      'admin',
      'GENERATE_KNOCKOUT_MATCHES',
      expect.stringContaining('轮次: QF'),
    );
  });

  it('支持 2 个小组 (A-B) 提取出线队并自动生成 4 强 (SF) 对阵', async () => {
    const mockStandingsCache = {
      groups: {
        A: [{ teamId: 'team-A1' }, { teamId: 'team-A2' }],
        B: [{ teamId: 'team-B1' }, { teamId: 'team-B2' }],
      },
    };

    prisma.season.findUnique.mockResolvedValue({
      id: 's1',
      type: 'CUP',
      standingsCache: mockStandingsCache,
    });

    const tx = {
      match: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'm1' }),
        update: jest.fn(),
      },
    };

    prisma.$transaction.mockImplementation(async (cb: (client: typeof tx) => unknown) => cb(tx));

    const result = await service.generateKnockoutMatches('s1', 'admin');
    expect(result.success).toBe(true);
    expect(result.round).toBe('SF');
    expect(result.countCreated).toBe(2);
  });

  it('不支持的小组数量 (如 3 个小组) 抛出 BadRequestException', async () => {
    const mockStandingsCache = {
      groups: {
        A: [{ teamId: 'team-A1' }],
        B: [{ teamId: 'team-B1' }],
        C: [{ teamId: 'team-C1' }],
      },
    };

    prisma.season.findUnique.mockResolvedValue({
      id: 's1',
      type: 'CUP',
      standingsCache: mockStandingsCache,
    });

    await expect(service.generateKnockoutMatches('s1', 'admin')).rejects.toThrow(
      '不支持的小组数量',
    );
  });
});
