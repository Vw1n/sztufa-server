export const MANDATORY_BACKUP_TABLES = [
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

export type MandatoryBackupTableName = (typeof MANDATORY_BACKUP_TABLES)[number];

export interface TableMeta {
  tableName: MandatoryBackupTableName;
  prismaDelegateName: string;
  cursorField: string;
  dateFields: string[];
  compositeUniqueKeys?: string[][];
  foreignKeys?: { field: string; targetTable: MandatoryBackupTableName }[];
}

export const TABLE_METADATA_MAP: Record<MandatoryBackupTableName, TableMeta> = {
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
};

export const RESTORE_DELETE_ORDER: MandatoryBackupTableName[] = [
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

export const RESTORE_INSERT_ORDER: MandatoryBackupTableName[] = [
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
