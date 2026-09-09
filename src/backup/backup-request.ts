import { BadRequestException } from '@nestjs/common';
import { BACKUP_MODULES, BackupModule } from './backup-module-registry';

export interface FullBackupRequest {
  readonly scope: 'full';
}

export interface SeasonModuleBackupRequest {
  readonly scope: 'module';
  readonly module: 'season';
  readonly selector: Readonly<{ seasonId: string }>;
}

export interface GlobalModuleBackupRequest {
  readonly scope: 'module';
  readonly module: Exclude<BackupModule, 'season'>;
  readonly selector: Readonly<Record<string, never>>;
}

export type BackupRequest =
  | FullBackupRequest
  | SeasonModuleBackupRequest
  | GlobalModuleBackupRequest;

type LegacySeasonRequest = { scope: 'season'; seasonId: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new BadRequestException(`${label} 包含不支持的字段: ${unexpected.join(', ')}`);
  }
}

/**
 * 将 V4 请求与历史 season 请求归一化为严格判别联合。
 * 当前 V3 writer 仍使用旧 CreateBackupOptions；本函数从 BE-02 起作为新 writer 的唯一入口。
 */
export function normalizeBackupRequest(input: unknown): BackupRequest {
  const value = input === undefined ? { scope: 'full' } : input;
  if (!isPlainObject(value)) {
    throw new BadRequestException('备份请求必须是对象');
  }

  if (value.scope === 'full') {
    assertExactKeys(value, ['scope'], '全量备份请求');
    return Object.freeze({ scope: 'full' });
  }

  if (value.scope === 'season') {
    assertExactKeys(value, ['scope', 'seasonId'], '历史分赛季备份请求');
    const legacy = value as LegacySeasonRequest;
    if (typeof legacy.seasonId !== 'string' || !legacy.seasonId.trim()) {
      throw new BadRequestException('分赛季备份必须提供非空 seasonId');
    }
    return Object.freeze({
      scope: 'module',
      module: 'season',
      selector: Object.freeze({ seasonId: legacy.seasonId.trim() }),
    });
  }

  if (value.scope !== 'module') {
    throw new BadRequestException(`不支持的备份 scope: ${String(value.scope)}`);
  }

  assertExactKeys(value, ['scope', 'module', 'selector'], '模块备份请求');
  if (typeof value.module !== 'string' || !BACKUP_MODULES.includes(value.module as BackupModule)) {
    throw new BadRequestException(`不支持的备份模块: ${String(value.module)}`);
  }
  if (!isPlainObject(value.selector)) {
    throw new BadRequestException('模块备份必须提供 selector 对象');
  }

  const module = value.module as BackupModule;
  if (module === 'season') {
    assertExactKeys(value.selector, ['seasonId'], '赛季 selector');
    const seasonId = value.selector.seasonId;
    if (typeof seasonId !== 'string' || !seasonId.trim()) {
      throw new BadRequestException('赛季模块必须提供非空 selector.seasonId');
    }
    return Object.freeze({
      scope: 'module',
      module,
      selector: Object.freeze({ seasonId: seasonId.trim() }),
    });
  }

  assertExactKeys(value.selector, [], `${module} selector`);
  return Object.freeze({ scope: 'module', module, selector: Object.freeze({}) });
}
