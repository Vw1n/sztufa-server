export type JsonRecord = Record<string, any>;

export interface NormalizedSeason {
  name: string;
}

export interface NormalizedTeam {
  name: string;
  seasonNames: Set<string>;
}

export interface NormalizedPlayer {
  key: string;
  legacyKey: string;
  name: string;
  teamName: string;
  jerseyNumber: string;
  seasonName: string | null;
}

export interface NormalizedEvent {
  eventId: string;
  eventTime: string;
  eventType: string;
  phase: 'REGULAR' | 'SHOOTOUT';
  shootoutRound: number | null;
  shootoutOrder: number | null;
  teamType: 'home' | 'away';
  teamName: string;
  playerName: string | null;
  jerseyNumber: string | null;
}

export interface NormalizedMatch {
  key: string;
  legacyGameId: string;
  gameId: string;
  seasonName: string;
  date: string;
  time: string | null;
  round: string | null;
  group: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  homePenaltyScore: number | null;
  awayPenaltyScore: number | null;
  events: NormalizedEvent[];
}

export interface NormalizedPackage {
  digest: string;
  files: Array<{
    name: string;
    type: 'season' | 'supplemental' | 'manifest';
    season?: string;
  }>;
  seasons: Map<string, NormalizedSeason>;
  teams: Map<string, NormalizedTeam>;
  players: Map<string, NormalizedPlayer>;
  matches: Map<string, NormalizedMatch>;
  warnings: string[];
  errors: string[];
}

export interface ImportEntityCounts {
  seasons: number;
  teams: number;
  players: number;
  matches: number;
  events: number;
}

export interface ImportPreview {
  digest: string;
  canImport: boolean;
  files: NormalizedPackage['files'];
  records: ImportEntityCounts;
  create: ImportEntityCounts;
  update: ImportEntityCounts;
  warnings: string[];
  errors: string[];
}

export interface ImportExecutionResult {
  digest: string;
  created: ImportEntityCounts;
  updated: ImportEntityCounts;
  warnings: string[];
}

export interface LastImportBatch {
  id: string;
  digest: string;
  username: string;
  status: string;
  summary: ImportExecutionResult;
  createdAt: Date;
}

export interface MatchUndoSnapshot {
  id: string;
  data: JsonRecord;
  goals: JsonRecord[];
  events: JsonRecord[];
}

export interface ImportUndoPayload {
  affectedSeasonIds: string[];
  created: {
    seasonIds: string[];
    teamIds: string[];
    profileIds: string[];
    playerIds: string[];
    rosterLinkIds: string[];
    matchIds: string[];
  };
  updated: {
    teams: Array<{ id: string; deletedAt: string | null }>;
    players: Array<{
      id: string;
      name: string;
      jerseyNumber: string;
      teamId: string;
      deletedAt: string | null;
    }>;
    rosterLinks: Array<{
      id: string;
      teamId: string;
      playerName?: string;
      jerseyNumber?: string;
      playerPhoto?: string | null;
    }>;
    matches: MatchUndoSnapshot[];
  };
}

export interface UndoImportResult {
  batchId: string;
  affectedSeasons: number;
  restoredMatches: number;
  deletedMatches: number;
  restoredPlayers: number;
  deletedPlayers: number;
  warnings: string[];
}
