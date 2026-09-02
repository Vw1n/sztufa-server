import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { UploadService, PromotedAsset } from '../upload/upload.service';
import { SeasonStatisticsService } from '../prisma/season-statistics.service';

export interface PreparedTeamAssets {
  teamId: string;
  normalizedDto: any;
  promotedAssets: PromotedAsset[];
  safeRollback: () => Promise<void>;
}

@Injectable()
export class TeamAssetPipelineService {
  private readonly logger = new Logger(TeamAssetPipelineService.name);

  constructor(
    private readonly uploadService: UploadService,
    private readonly seasonStatistics: SeasonStatisticsService,
  ) {}

  async prepareTeamAssets(
    dto: any,
    username: string = 'admin',
    userCtx?: { role?: string },
    existingTeamId?: string,
    mode?: 'create' | 'update',
  ): Promise<PreparedTeamAssets> {
    const effectiveMode: 'create' | 'update' = mode || (existingTeamId ? 'update' : 'create');
    const teamId = existingTeamId || dto.id || crypto.randomUUID();
    const dedupeMap = new Map<string, Promise<PromotedAsset | null>>();

    const registerPromotion = (
      urlOrKey: string | null | undefined,
      subpath: string,
    ): string | null => {
      if (!urlOrKey || typeof urlOrKey !== 'string') return null;
      const clean = urlOrKey.trim();
      if (!clean) return null;

      const sourceKey = this.uploadService.extractKeyFromUrl(clean);
      const dedupeKey = `${sourceKey}::${subpath}`;

      if (!dedupeMap.has(dedupeKey)) {
        const promise = this.uploadService.promoteTempAsset(clean, subpath, username, userCtx);
        dedupeMap.set(dedupeKey, promise);
      }
      return dedupeKey;
    };

    // 1. 登记所有需要转存的资源
    const teamLogoDedupeKey = registerPromotion(dto.teamLogo, `teams/${teamId}/logo`);
    const homeJerseyDedupeKey = registerPromotion(dto.homeJersey, `teams/${teamId}/home_jersey`);
    const awayJerseyDedupeKey = registerPromotion(dto.awayJersey, `teams/${teamId}/away_jersey`);

    const rawPlayers = Array.isArray(dto.players) ? dto.players : [];
    const playerTasks = rawPlayers.map((player: any) => {
      const rawId =
        typeof player?.id === 'string' &&
        player.id.trim() !== '' &&
        !player.id.startsWith('temp_') &&
        !player.id.startsWith('temp-')
          ? player.id.trim()
          : undefined;
      const preallocatedPlayerId = rawId || crypto.randomUUID();
      const photoSource = player?.photo !== undefined ? player.photo : player?.playerPhoto;
      const photoDedupeKey = registerPromotion(
        photoSource,
        `players/${preallocatedPlayerId}/photo`,
      );

      return {
        player,
        rawId,
        preallocatedPlayerId,
        photoSource,
        photoDedupeKey,
      };
    });

    // 2. 等待所有并发转存任务彻底 settle，防止首个失败后其他后台任务稍后成功产生孤儿对象
    const settledResults = await Promise.allSettled(Array.from(dedupeMap.values()));
    const rejected = settledResults.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    if (rejected) {
      const keysToDelete: string[] = [];
      for (const r of settledResults) {
        if (r.status === 'fulfilled' && r.value && r.value.isPromoted && r.value.formalKey) {
          keysToDelete.push(r.value.formalKey);
        }
      }
      if (keysToDelete.length > 0) {
        try {
          await this.uploadService.deleteObjects(keysToDelete);
        } catch (cleanupErr) {
          this.logger.error(
            `[prepareTeamAssets] 预转存失败全量补偿清理异常: keys=${keysToDelete.join(', ')}`,
            cleanupErr instanceof Error ? cleanupErr.stack : String(cleanupErr),
          );
        }
      }
      throw rejected.reason;
    }

    // 3. 所有任务成功，装配已转存的结果
    const createdFormalKeys: string[] = [];
    const promotedAssets: PromotedAsset[] = [];

    for (const r of settledResults) {
      if (r.status === 'fulfilled' && r.value && r.value.isPromoted) {
        createdFormalKeys.push(r.value.formalKey);
        promotedAssets.push(r.value);
      }
    }

    const teamLogoAsset = teamLogoDedupeKey ? await dedupeMap.get(teamLogoDedupeKey)! : null;
    const homeJerseyAsset = homeJerseyDedupeKey ? await dedupeMap.get(homeJerseyDedupeKey)! : null;
    const awayJerseyAsset = awayJerseyDedupeKey ? await dedupeMap.get(awayJerseyDedupeKey)! : null;

    const resolveAssetValue = (
      rawVal: any,
      promoted: PromotedAsset | null,
      mode: 'create' | 'update',
    ): string | null | undefined => {
      if (rawVal === undefined) {
        return mode === 'create' ? null : undefined;
      }
      if (rawVal === null) {
        return null;
      }
      return promoted ? promoted.formalUrl : rawVal;
    };

    const resolvePlayerPhoto = (
      rawVal: any,
      promoted: PromotedAsset | null,
      isExistingPlayer: boolean,
    ): string | null | undefined => {
      if (rawVal === undefined) {
        return isExistingPlayer ? undefined : null;
      }
      if (rawVal === null) {
        return null;
      }
      return promoted ? promoted.formalUrl : rawVal;
    };

    const preparedPlayers = await Promise.all(
      playerTasks.map(async (task) => {
        const photoAsset = task.photoDedupeKey ? await dedupeMap.get(task.photoDedupeKey)! : null;
        return {
          ...task.player,
          id: task.rawId,
          preallocatedPlayerId: task.preallocatedPlayerId,
          photo: resolvePlayerPhoto(task.photoSource, photoAsset, Boolean(task.rawId)),
        };
      }),
    );

    const normalizedDto = {
      ...dto,
      preallocatedTeamId: !existingTeamId ? teamId : undefined,
      teamLogo: resolveAssetValue(dto.teamLogo, teamLogoAsset, effectiveMode),
      homeJersey: resolveAssetValue(dto.homeJersey, homeJerseyAsset, effectiveMode),
      awayJersey: resolveAssetValue(dto.awayJersey, awayJerseyAsset, effectiveMode),
      players: preparedPlayers,
    };

    const safeRollback = async () => {
      if (createdFormalKeys.length === 0) return;
      try {
        await this.uploadService.deleteObjects(createdFormalKeys);
      } catch (rollbackErr) {
        this.logger.error(
          `[safeRollback] 补偿清理正式对象失败: keys=${createdFormalKeys.join(', ')}`,
          rollbackErr instanceof Error ? rollbackErr.stack : String(rollbackErr),
        );
      }
    };

    return {
      teamId,
      normalizedDto,
      promotedAssets,
      safeRollback,
    };
  }

  async safePostCommit(
    prepared: PreparedTeamAssets,
    username: string,
    seasonId?: string,
  ): Promise<void> {
    const oldKeysToClean = prepared.promotedAssets
      .filter((a) => a.isPromoted && a.oldKey)
      .map((a) => a.oldKey);

    if (oldKeysToClean.length > 0) {
      try {
        await this.uploadService.cleanupTempKeys(oldKeysToClean, username);
      } catch (cleanErr) {
        this.logger.error(
          `[safePostCommit] 异步清理临时对象失败: ${cleanErr}`,
          cleanErr instanceof Error ? cleanErr.stack : String(cleanErr),
        );
      }
    }

    if (seasonId) {
      try {
        const cacheRes = await this.seasonStatistics.computeAndCache(seasonId);
        if (!cacheRes.success) {
          this.logger.warn(`[safePostCommit] 重建赛季缓存未完全成功: ${cacheRes.error}`);
        }
      } catch (cacheErr) {
        this.logger.error(
          `[safePostCommit] 重建赛季缓存异常: ${cacheErr}`,
          cacheErr instanceof Error ? cacheErr.stack : String(cacheErr),
        );
      }
    }
  }
}
