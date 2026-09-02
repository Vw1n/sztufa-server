import { describe, expect, it, jest } from '@jest/globals';
import { TeamAssetPipelineService } from './team-asset-pipeline.service';

describe('TeamAssetPipelineService', () => {
  const createPipeline = () => {
    const uploadService: any = {
      extractKeyFromUrl: jest.fn((url: string) => {
        if (url.startsWith('https://assets.sztufa.xyz/')) {
          return url.replace('https://assets.sztufa.xyz/', '');
        }
        return url;
      }),
      promoteTempAsset: jest.fn(async (url: string, subpath: string) => {
        if (url && url.includes('temp/')) {
          const fileName = url.substring(url.lastIndexOf('/') + 1);
          return {
            originalUrl: url,
            formalUrl: `https://assets.sztufa.xyz/uploads/${subpath}/${fileName}`,
            formalKey: `uploads/${subpath}/${fileName}`,
            oldKey: url.replace('https://assets.sztufa.xyz/', ''),
            isPromoted: true,
          };
        }
        return {
          originalUrl: url,
          formalUrl: url,
          formalKey: url,
          oldKey: url,
          isPromoted: false,
        };
      }),
      deleteObjects: jest.fn(async () => {}),
      cleanupTempKeys: jest.fn(async () => ({ cleanedCount: 1 })),
    };

    const seasonStatistics: any = {
      computeAndCache: jest.fn(async () => ({ success: true })),
    };

    const service = new TeamAssetPipelineService(uploadService, seasonStatistics);
    return { service, uploadService, seasonStatistics };
  };

  it('pre-allocates deterministic IDs and promotes temp assets with deduplication', async () => {
    const { service, uploadService } = createPipeline();

    const dto = {
      teamName: '测试战队',
      teamLogo: 'https://assets.sztufa.xyz/temp/user_abc/logo.webp',
      homeJersey: 'https://assets.sztufa.xyz/temp/user_abc/jersey.webp',
      players: [
        {
          id: 'existing-player-1',
          name: '老球员',
          photo: 'https://assets.sztufa.xyz/temp/user_abc/p1.webp',
        },
        {
          name: '新球员1',
          photo: 'https://assets.sztufa.xyz/temp/user_abc/duplicate_p.webp',
        },
        {
          name: '新球员2',
          photo: 'https://assets.sztufa.xyz/temp/user_abc/duplicate_p.webp', // 同一球员照片多次复用
        },
      ],
    };

    const prepared = await service.prepareTeamAssets(dto, 'userA');

    expect(prepared.teamId).toBeDefined();
    expect(prepared.normalizedDto.preallocatedTeamId).toBe(prepared.teamId);
    expect(prepared.normalizedDto.teamLogo).toContain('uploads/teams/');
    expect(prepared.normalizedDto.players[0].id).toBe('existing-player-1');
    expect(prepared.normalizedDto.players[0].preallocatedPlayerId).toBe('existing-player-1');
    expect(prepared.normalizedDto.players[1].id).toBeUndefined();
    expect(prepared.normalizedDto.players[1].preallocatedPlayerId).toBeDefined();

    // 验证在同一作用域内重复使用同一临时图片只触发一次转存
    const playerPhotoCalls = uploadService.promoteTempAsset.mock.calls.filter(
      (c: any[]) => c[0] === 'https://assets.sztufa.xyz/temp/user_abc/duplicate_p.webp',
    );
    expect(playerPhotoCalls.length).toBe(2); // 球员作用域各自为 preallocatedPlayerId (不同子路径)
  });

  it('compensates and deletes formal objects if promotion fails midway', async () => {
    const { service, uploadService } = createPipeline();

    uploadService.promoteTempAsset.mockImplementation(async (url: string, subpath: string) => {
      if (url.includes('jersey')) {
        throw new Error('S3 500 Connection Timeout');
      }
      // 模拟另外一个任务耗时稍长
      await new Promise((r) => setTimeout(r, 10));
      return {
        originalUrl: url,
        formalUrl: `https://assets.sztufa.xyz/uploads/${subpath}/delayed.webp`,
        formalKey: `uploads/${subpath}/delayed.webp`,
        oldKey: 'temp/user_abc/file.webp',
        isPromoted: true,
      };
    });

    const dto = {
      teamLogo: 'https://assets.sztufa.xyz/temp/user_abc/logo.webp',
      homeJersey: 'https://assets.sztufa.xyz/temp/user_abc/jersey.webp',
    };

    await expect(service.prepareTeamAssets(dto, 'userA')).rejects.toThrow('S3 500 Connection Timeout');
    expect(uploadService.deleteObjects).toHaveBeenCalled();
    const deletedKeys = uploadService.deleteObjects.mock.calls[0][0] as string[];
    expect(deletedKeys.length).toBe(1);
    expect(deletedKeys[0]).toContain('/logo/delayed.webp');
  });

  it('safeRollback deletes created formal keys without throwing errors', async () => {
    const { service, uploadService } = createPipeline();
    uploadService.deleteObjects.mockRejectedValue(new Error('S3 Network error'));

    const dto = {
      teamLogo: 'https://assets.sztufa.xyz/temp/user_abc/logo.webp',
    };

    const prepared = await service.prepareTeamAssets(dto, 'userA');
    // safeRollback 内部应隔离异常
    await expect(prepared.safeRollback()).resolves.toBeUndefined();
    expect(uploadService.deleteObjects).toHaveBeenCalled();
  });

  it('safePostCommit isolates errors from cleanup and cache rebuild', async () => {
    const { service, uploadService, seasonStatistics } = createPipeline();
    uploadService.cleanupTempKeys.mockRejectedValue(new Error('Cleanup network down'));
    seasonStatistics.computeAndCache.mockResolvedValue({ success: false, error: 'DB lock timeout' });

    const dto = {
      teamLogo: 'https://assets.sztufa.xyz/temp/user_abc/logo.webp',
    };

    const prepared = await service.prepareTeamAssets(dto, 'userA');
    // safePostCommit 失败时绝不向调用方抛错
    await expect(service.safePostCommit(prepared, 'userA', 'season-123')).resolves.toBeUndefined();
    expect(uploadService.cleanupTempKeys).toHaveBeenCalled();
    expect(seasonStatistics.computeAndCache).toHaveBeenCalledWith('season-123');
  });

  describe('undefined vs null semantics (create vs update)', () => {
    it('in update mode: omitted assets remain undefined, explicit null remains null', async () => {
      const { service } = createPipeline();

      const updateDto = {
        teamName: '更新队名',
        // teamLogo omitted (undefined)
        homeJersey: null, // explicit clear
        awayJersey: 'https://assets.sztufa.xyz/uploads/teams/team-1/away.webp', // existing formal
        players: [
          { id: 'player-1', name: '已有球员' }, // photo omitted (undefined)
          { id: 'player-2', name: '清空照片球员', photo: null },
          { name: '新球员' }, // new player, photo omitted (should default to null)
        ],
      };

      const prepared = await service.prepareTeamAssets(updateDto, 'userA', undefined, 'team-1', 'update');

      expect(prepared.normalizedDto.teamLogo).toBeUndefined();
      expect(prepared.normalizedDto.homeJersey).toBeNull();
      expect(prepared.normalizedDto.awayJersey).toBe('https://assets.sztufa.xyz/uploads/teams/team-1/away.webp');
      expect(prepared.normalizedDto.players[0].photo).toBeUndefined();
      expect(prepared.normalizedDto.players[1].photo).toBeNull();
      expect(prepared.normalizedDto.players[2].photo).toBeNull();
    });

    it('in create mode: omitted assets default to null', async () => {
      const { service } = createPipeline();

      const createDto = {
        teamName: '新建球队',
        // teamLogo, homeJersey, awayJersey omitted (undefined)
        players: [
          { name: '新球员' }, // photo omitted
        ],
      };

      const prepared = await service.prepareTeamAssets(createDto, 'userA', undefined, undefined, 'create');

      expect(prepared.normalizedDto.teamLogo).toBeNull();
      expect(prepared.normalizedDto.homeJersey).toBeNull();
      expect(prepared.normalizedDto.awayJersey).toBeNull();
      expect(prepared.normalizedDto.players[0].photo).toBeNull();
    });
  });
});
