import { Injectable } from '@nestjs/common';
import {
  BACKUP_MODULE_REGISTRY,
  BackupModule,
  BackupTableRole,
  FULL_BACKUP_TABLES,
} from './backup-module-registry';
import { BackupRequest, normalizeBackupRequest } from './backup-request';
import { PersistentBackupTableName, TABLE_METADATA_MAP } from './backup-table-registry';
import { BackupScopeService, SeasonInfo } from './backup-scope.service';

export interface BackupPlanTable {
  readonly tableName: PersistentBackupTableName;
  readonly role: BackupTableRole;
  readonly where: Readonly<Record<string, unknown>>;
  readonly orderBy: Readonly<Record<string, 'asc'>>;
}

export interface BackupPlan {
  readonly scope: 'full' | 'module';
  readonly module: 'full' | BackupModule;
  readonly selector: Readonly<Record<string, string>>;
  readonly season?: Readonly<SeasonInfo>;
  readonly tables: readonly BackupPlanTable[];
  readonly externalDependencies: readonly PersistentBackupTableName[];
}

const SEASON_DIRECT_TABLES = new Set<PersistentBackupTableName>([
  'SeasonTeamProfile',
  'SeasonTeamPlayer',
  'SeasonGroupTeam',
  'SeasonDeletionApproval',
  'Match',
  'TeamRegistration',
]);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}

export function getSeasonModuleWhereClause(
  tableName: PersistentBackupTableName,
  seasonId: string,
): Record<string, unknown> {
  if (tableName === 'Season') return { id: seasonId };
  if (SEASON_DIRECT_TABLES.has(tableName)) return { seasonId };
  if (['MatchLineup', 'MatchEvent', 'Goal', 'Prediction'].includes(tableName)) {
    return { match: { seasonId } };
  }
  if (tableName === 'RegistrationTeamData' || tableName === 'RegistrationPlayer') {
    return { registration: { seasonId } };
  }
  if (tableName === 'Team') {
    return {
      OR: [
        { seasonProfiles: { some: { seasonId } } },
        { seasonPlayers: { some: { seasonId } } },
        { groupTeams: { some: { seasonId } } },
        { homeMatches: { some: { seasonId } } },
        { awayMatches: { some: { seasonId } } },
        { registrations: { some: { seasonId } } },
      ],
    };
  }
  if (tableName === 'Player') {
    return {
      OR: [
        { seasonPlayers: { some: { seasonId } } },
        { matchLineups: { some: { match: { seasonId } } } },
        { goals: { some: { match: { seasonId } } } },
        { events: { some: { match: { seasonId } } } },
        { subEvents: { some: { match: { seasonId } } } },
        { assistEvents: { some: { match: { seasonId } } } },
        { mvpMatches: { some: { seasonId } } },
        { registrationPlayers: { some: { registration: { seasonId } } } },
      ],
    };
  }
  return {};
}

@Injectable()
export class BackupPlanService {
  constructor(private readonly scopeService: BackupScopeService) {}

  async compile(input: unknown): Promise<BackupPlan> {
    const request = normalizeBackupRequest(input);
    if (request.scope === 'full') return this.compileFullPlan(request);
    return this.compileModulePlan(request);
  }

  private compileFullPlan(_request: BackupRequest): BackupPlan {
    return Object.freeze({
      scope: 'full',
      module: 'full',
      selector: Object.freeze({}),
      tables: Object.freeze(FULL_BACKUP_TABLES.map((table) => this.tablePlan(table, 'owned', {}))),
      externalDependencies: Object.freeze([]),
    });
  }

  private async compileModulePlan(
    request: Exclude<BackupRequest, { scope: 'full' }>,
  ): Promise<BackupPlan> {
    const definition = BACKUP_MODULE_REGISTRY[request.module];
    let season: Readonly<SeasonInfo> | undefined;
    let selector: Readonly<Record<string, string>> = Object.freeze({});

    if (request.module === 'season') {
      season = deepFreeze(await this.scopeService.validateSeason(request.selector.seasonId));
      selector = Object.freeze({ seasonId: request.selector.seasonId });
    }

    const seasonId = request.module === 'season' ? request.selector.seasonId : undefined;
    const tables = [
      ...definition.ownedTables.map((table) =>
        this.tablePlan(table, 'owned', seasonId ? getSeasonModuleWhereClause(table, seasonId) : {}),
      ),
      ...definition.referenceTables.map((table) =>
        this.tablePlan(
          table,
          'reference',
          seasonId ? getSeasonModuleWhereClause(table, seasonId) : {},
        ),
      ),
    ];

    return Object.freeze({
      scope: 'module',
      module: request.module,
      selector,
      season,
      tables: Object.freeze(tables),
      externalDependencies: Object.freeze([...definition.externalTables]),
    });
  }

  private tablePlan(
    tableName: PersistentBackupTableName,
    role: BackupTableRole,
    where: Record<string, unknown>,
  ): BackupPlanTable {
    const meta = TABLE_METADATA_MAP[tableName];
    return Object.freeze({
      tableName,
      role,
      where: deepFreeze(where),
      orderBy: Object.freeze({ [meta.cursorField]: 'asc' as const }),
    });
  }
}
