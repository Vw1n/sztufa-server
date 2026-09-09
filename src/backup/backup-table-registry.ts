export const LEGACY_V3_REQUIRED_TABLES = [
  'User',
  'MemberAccount',
  'Team',
  'Player',
  'Season',
  'Match',
  'Prediction',
  'Goal',
  'MatchEvent',
  'News',
  'AuditLog',
  'SeasonTeamProfile',
  'HistoryImportBatch',
  'SeasonDeletionApproval',
  'SeasonTeamPlayer',
  'MatchLineup',
  'SeasonGroupTeam',
  'PdfImportBatch',
] as const;

export type LegacyBackupTableName = (typeof LEGACY_V3_REQUIRED_TABLES)[number];

// 兼容现有代码调用的别名
export const MANDATORY_BACKUP_TABLES = LEGACY_V3_REQUIRED_TABLES;
export type MandatoryBackupTableName = LegacyBackupTableName;

export const EXCLUDED_BACKUP_MODELS = ['CampusCardAsset', 'AuthRateLimit'] as const;
export type ExcludedBackupModel = (typeof EXCLUDED_BACKUP_MODELS)[number];

export const V4_PERSISTENT_MODELS = [
  ...LEGACY_V3_REQUIRED_TABLES,
  'AdminFormDraft',
  'TeamRegistration',
  'RegistrationTeamData',
  'RegistrationPlayer',
] as const;

export type PersistentBackupTableName = (typeof V4_PERSISTENT_MODELS)[number];

export interface TableMeta {
  tableName: PersistentBackupTableName;
  prismaDelegateName: string;
  cursorField: string;
  dateFields: string[];
  compositeUniqueKeys?: string[][];
  foreignKeys?: { field: string; targetTable: PersistentBackupTableName }[];
}

export const TABLE_METADATA_MAP: Record<PersistentBackupTableName, TableMeta> = {
  User: {
    tableName: 'User',
    prismaDelegateName: 'user',
    cursorField: 'id',
    dateFields: ['createdAt', 'updatedAt'],
    foreignKeys: [{ field: 'teamId', targetTable: 'Team' }],
  },
  MemberAccount: {
    tableName: 'MemberAccount',
    prismaDelegateName: 'memberAccount',
    cursorField: 'id',
    dateFields: ['createdAt', 'updatedAt', 'reviewedAt'],
  },
  Team: {
    tableName: 'Team',
    prismaDelegateName: 'team',
    cursorField: 'id',
    dateFields: ['createdAt', 'updatedAt', 'deletedAt'],
  },
  Player: {
    tableName: 'Player',
    prismaDelegateName: 'player',
    cursorField: 'id',
    dateFields: ['createdAt', 'updatedAt', 'deletedAt'],
    foreignKeys: [
      { field: 'teamId', targetTable: 'Team' },
      { field: 'suspendedAtMatchId', targetTable: 'Match' },
    ],
  },
  Season: {
    tableName: 'Season',
    prismaDelegateName: 'season',
    cursorField: 'id',
    dateFields: ['createdAt', 'updatedAt'],
  },
  Match: {
    tableName: 'Match',
    prismaDelegateName: 'match',
    cursorField: 'id',
    dateFields: ['matchDate', 'createdAt', 'updatedAt', 'deletedAt'],
    foreignKeys: [
      { field: 'homeTeamId', targetTable: 'Team' },
      { field: 'awayTeamId', targetTable: 'Team' },
      { field: 'seasonId', targetTable: 'Season' },
      { field: 'mvpPlayerId', targetTable: 'Player' },
    ],
  },
  Prediction: {
    tableName: 'Prediction',
    prismaDelegateName: 'prediction',
    cursorField: 'id',
    dateFields: ['submittedAt', 'settledAt', 'createdAt', 'updatedAt'],
    compositeUniqueKeys: [['userId', 'matchId']],
    foreignKeys: [
      { field: 'userId', targetTable: 'MemberAccount' },
      { field: 'matchId', targetTable: 'Match' },
    ],
  },
  Goal: {
    tableName: 'Goal',
    prismaDelegateName: 'goal',
    cursorField: 'id',
    dateFields: ['createdAt'],
    foreignKeys: [
      { field: 'matchId', targetTable: 'Match' },
      { field: 'playerId', targetTable: 'Player' },
    ],
  },
  MatchEvent: {
    tableName: 'MatchEvent',
    prismaDelegateName: 'matchEvent',
    cursorField: 'id',
    dateFields: ['createdAt'],
    foreignKeys: [
      { field: 'matchId', targetTable: 'Match' },
      { field: 'playerId', targetTable: 'Player' },
      { field: 'subPlayerId', targetTable: 'Player' },
      { field: 'assistPlayerId', targetTable: 'Player' },
    ],
  },
  News: {
    tableName: 'News',
    prismaDelegateName: 'news',
    cursorField: 'id',
    dateFields: ['publishedAt', 'createdAt', 'updatedAt', 'deletedAt'],
  },
  AuditLog: {
    tableName: 'AuditLog',
    prismaDelegateName: 'auditLog',
    cursorField: 'id',
    dateFields: ['createdAt'],
  },
  SeasonTeamProfile: {
    tableName: 'SeasonTeamProfile',
    prismaDelegateName: 'seasonTeamProfile',
    cursorField: 'id',
    dateFields: ['createdAt', 'updatedAt'],
    compositeUniqueKeys: [['seasonId', 'teamId']],
    foreignKeys: [
      { field: 'seasonId', targetTable: 'Season' },
      { field: 'teamId', targetTable: 'Team' },
    ],
  },
  HistoryImportBatch: {
    tableName: 'HistoryImportBatch',
    prismaDelegateName: 'historyImportBatch',
    cursorField: 'id',
    dateFields: ['createdAt', 'undoneAt'],
  },
  SeasonDeletionApproval: {
    tableName: 'SeasonDeletionApproval',
    prismaDelegateName: 'seasonDeletionApproval',
    cursorField: 'id',
    dateFields: ['createdAt'],
    compositeUniqueKeys: [['seasonId', 'approverId']],
    foreignKeys: [
      { field: 'seasonId', targetTable: 'Season' },
      { field: 'approverId', targetTable: 'User' },
    ],
  },
  SeasonTeamPlayer: {
    tableName: 'SeasonTeamPlayer',
    prismaDelegateName: 'seasonTeamPlayer',
    cursorField: 'id',
    dateFields: ['createdAt'],
    compositeUniqueKeys: [['seasonId', 'playerId']],
    foreignKeys: [
      { field: 'seasonId', targetTable: 'Season' },
      { field: 'teamId', targetTable: 'Team' },
      { field: 'playerId', targetTable: 'Player' },
    ],
  },
  MatchLineup: {
    tableName: 'MatchLineup',
    prismaDelegateName: 'matchLineup',
    cursorField: 'id',
    dateFields: [],
    compositeUniqueKeys: [['matchId', 'playerId']],
    foreignKeys: [
      { field: 'matchId', targetTable: 'Match' },
      { field: 'playerId', targetTable: 'Player' },
    ],
  },
  SeasonGroupTeam: {
    tableName: 'SeasonGroupTeam',
    prismaDelegateName: 'seasonGroupTeam',
    cursorField: 'id',
    dateFields: ['createdAt'],
    compositeUniqueKeys: [['seasonId', 'teamId']],
    foreignKeys: [
      { field: 'seasonId', targetTable: 'Season' },
      { field: 'teamId', targetTable: 'Team' },
    ],
  },
  PdfImportBatch: {
    tableName: 'PdfImportBatch',
    prismaDelegateName: 'pdfImportBatch',
    cursorField: 'id',
    dateFields: [
      'expiresAt',
      'commitStartedAt',
      'committedAt',
      'failedAt',
      'createdAt',
      'updatedAt',
    ],
  },
  AdminFormDraft: {
    tableName: 'AdminFormDraft',
    prismaDelegateName: 'adminFormDraft',
    cursorField: 'id',
    dateFields: ['createdAt', 'updatedAt'],
    foreignKeys: [],
  },
  TeamRegistration: {
    tableName: 'TeamRegistration',
    prismaDelegateName: 'teamRegistration',
    cursorField: 'id',
    dateFields: ['submittedAt', 'reviewedAt', 'createdAt', 'updatedAt'],
    compositeUniqueKeys: [['seasonId', 'teamId']],
    foreignKeys: [
      { field: 'seasonId', targetTable: 'Season' },
      { field: 'teamId', targetTable: 'Team' },
      { field: 'submittedById', targetTable: 'User' },
      { field: 'reviewedById', targetTable: 'User' },
    ],
  },
  RegistrationTeamData: {
    tableName: 'RegistrationTeamData',
    prismaDelegateName: 'registrationTeamData',
    cursorField: 'id',
    dateFields: ['createdAt', 'updatedAt'],
    foreignKeys: [{ field: 'registrationId', targetTable: 'TeamRegistration' }],
  },
  RegistrationPlayer: {
    tableName: 'RegistrationPlayer',
    prismaDelegateName: 'registrationPlayer',
    cursorField: 'id',
    dateFields: ['createdAt', 'updatedAt'],
    foreignKeys: [
      { field: 'registrationId', targetTable: 'TeamRegistration' },
      { field: 'playerId', targetTable: 'Player' },
    ],
  },
};

export const LEGACY_V3_RESTORE_DELETE_ORDER: LegacyBackupTableName[] = [
  'MatchLineup',
  'SeasonTeamPlayer',
  'SeasonTeamProfile',
  'SeasonGroupTeam',
  'SeasonDeletionApproval',
  'Goal',
  'MatchEvent',
  'Prediction',
  'Player',
  'Match',
  'Team',
  'User',
  'MemberAccount',
  'Season',
  'News',
  'AuditLog',
  'HistoryImportBatch',
  'PdfImportBatch',
];

export const LEGACY_V3_RESTORE_INSERT_ORDER: LegacyBackupTableName[] = [
  'User',
  'MemberAccount',
  'Season',
  'Team',
  'Player',
  'Match',
  'SeasonTeamProfile',
  'SeasonGroupTeam',
  'SeasonTeamPlayer',
  'SeasonDeletionApproval',
  'MatchLineup',
  'Goal',
  'MatchEvent',
  'Prediction',
  'News',
  'AuditLog',
  'HistoryImportBatch',
  'PdfImportBatch',
];

// 兼容已有代码调用，严格保持 18 表，绝不包含新增 4 表
export const RESTORE_DELETE_ORDER = LEGACY_V3_RESTORE_DELETE_ORDER;
export const RESTORE_INSERT_ORDER = LEGACY_V3_RESTORE_INSERT_ORDER;
