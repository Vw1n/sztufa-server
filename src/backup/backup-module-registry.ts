import { PersistentBackupTableName, V4_PERSISTENT_MODELS } from './backup-table-registry';

export const BACKUP_MODULES = ['season', 'staff', 'members', 'content', 'operations'] as const;

export type BackupModule = (typeof BACKUP_MODULES)[number];
export type BackupTableRole = 'owned' | 'reference' | 'external';

export interface BackupModuleDefinition {
  readonly module: BackupModule;
  readonly ownedTables: readonly PersistentBackupTableName[];
  readonly referenceTables: readonly PersistentBackupTableName[];
  readonly externalTables: readonly PersistentBackupTableName[];
  readonly selector: 'season' | 'none';
  readonly restoreStrategy: 'replace-module' | 'merge' | 'merge-only';
  readonly sensitivity: 'standard' | 'sensitive';
}

export const BACKUP_MODULE_REGISTRY: Readonly<Record<BackupModule, BackupModuleDefinition>> =
  Object.freeze({
    season: Object.freeze({
      module: 'season',
      ownedTables: Object.freeze([
        'Season',
        'Match',
        'Goal',
        'MatchEvent',
        'MatchLineup',
        'SeasonTeamProfile',
        'SeasonTeamPlayer',
        'SeasonGroupTeam',
        'SeasonDeletionApproval',
        'TeamRegistration',
        'RegistrationTeamData',
        'RegistrationPlayer',
        'Prediction',
      ] satisfies PersistentBackupTableName[]),
      referenceTables: Object.freeze(['Team', 'Player'] satisfies PersistentBackupTableName[]),
      externalTables: Object.freeze([
        'User',
        'MemberAccount',
      ] satisfies PersistentBackupTableName[]),
      selector: 'season',
      restoreStrategy: 'replace-module',
      sensitivity: 'standard',
    }),
    staff: Object.freeze({
      module: 'staff',
      ownedTables: Object.freeze(['User', 'AdminFormDraft'] satisfies PersistentBackupTableName[]),
      referenceTables: Object.freeze([] as PersistentBackupTableName[]),
      externalTables: Object.freeze([] as PersistentBackupTableName[]),
      selector: 'none',
      restoreStrategy: 'merge',
      sensitivity: 'sensitive',
    }),
    members: Object.freeze({
      module: 'members',
      ownedTables: Object.freeze(['MemberAccount'] satisfies PersistentBackupTableName[]),
      referenceTables: Object.freeze([] as PersistentBackupTableName[]),
      externalTables: Object.freeze([] as PersistentBackupTableName[]),
      selector: 'none',
      restoreStrategy: 'merge',
      sensitivity: 'sensitive',
    }),
    content: Object.freeze({
      module: 'content',
      ownedTables: Object.freeze(['News'] satisfies PersistentBackupTableName[]),
      referenceTables: Object.freeze([] as PersistentBackupTableName[]),
      externalTables: Object.freeze([] as PersistentBackupTableName[]),
      selector: 'none',
      restoreStrategy: 'merge',
      sensitivity: 'standard',
    }),
    operations: Object.freeze({
      module: 'operations',
      ownedTables: Object.freeze([
        'AuditLog',
        'HistoryImportBatch',
        'PdfImportBatch',
      ] satisfies PersistentBackupTableName[]),
      referenceTables: Object.freeze([] as PersistentBackupTableName[]),
      externalTables: Object.freeze([] as PersistentBackupTableName[]),
      selector: 'none',
      restoreStrategy: 'merge-only',
      sensitivity: 'standard',
    }),
  });

export const FULL_BACKUP_TABLES: readonly PersistentBackupTableName[] = Object.freeze([
  ...V4_PERSISTENT_MODELS,
]);
