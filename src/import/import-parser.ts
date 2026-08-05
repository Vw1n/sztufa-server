import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  ImportEntityCounts,
  JsonRecord,
  NormalizedEvent,
  NormalizedMatch,
  NormalizedPackage,
  NormalizedPlayer,
} from './import.types';

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_LOCATION = '深圳技术大学足球场';
export const UNKNOWN_JERSEY = '未记录';

export const HISTORY_EVENT_TYPES: Record<string, string> = {
  goal: 'goal',
  penalty: 'penalty',
  own_goal: 'own_goal',
  yellow_card: 'yellow_card',
  red_card: 'red_card',
  penalty_miss: 'penalty_miss',
  penalty_shootout_goal: 'penalty_shootout_goal',
  penalty_shootout_miss: 'penalty_shootout_miss',
  进球: 'goal',
  '进球(点球)': 'penalty',
  乌龙: 'own_goal',
  乌龙球: 'own_goal',
  黄牌: 'yellow_card',
  红牌: 'red_card',
  失点: 'penalty_miss',
  点球罚丢: 'penalty_miss',
  点球大战罚中: 'penalty_shootout_goal',
  点球大战罚失: 'penalty_shootout_miss',
  罚中: 'penalty_shootout_goal',
  罚失: 'penalty_shootout_miss',
};

export const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

export const text = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

export const integer = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const normalizedText = text(value);
  return normalizedText && /^\d+$/.test(normalizedText) ? Number(normalizedText) : null;
};

export const stableHash = (value: string, length = 24): string =>
  createHash('sha256').update(value).digest('hex').slice(0, length);

export class ImportParser {
  static emptyCounts(): ImportEntityCounts {
    return {
      seasons: 0,
      teams: 0,
      players: 0,
      matches: 0,
      events: 0,
    };
  }

  static countRecords(normalized: NormalizedPackage): ImportEntityCounts {
    let events = 0;
    for (const match of normalized.matches.values()) {
      events += match.events.length;
    }
    return {
      seasons: normalized.seasons.size,
      teams: normalized.teams.size,
      players: normalized.players.size,
      matches: normalized.matches.size,
      events,
    };
  }

  static playerKey(teamName: string, playerName: string, seasonName: string | null): string {
    return seasonName
      ? `${seasonName}::${teamName}::${playerName}`
      : `supplemental::${teamName}::${playerName}`;
  }

  static matchKey(gameId: string, seasonName: string): string {
    return `${seasonName}::${gameId}`;
  }

  static normalizeFiles(files: Express.Multer.File[]): NormalizedPackage {
    if (!files || files.length === 0) {
      throw new BadRequestException('请选择至少一个 JSON 文件');
    }
    if (files.length > MAX_FILES) {
      throw new BadRequestException(`一次最多上传 ${MAX_FILES} 个 JSON 文件`);
    }

    const sortedFiles = [...files].sort((left, right) =>
      left.originalname.localeCompare(right.originalname, 'zh-CN'),
    );
    const digestBuilder = createHash('sha256');
    for (const file of sortedFiles) {
      digestBuilder.update(file.originalname);
      digestBuilder.update(file.buffer);
    }

    const normalized: NormalizedPackage = {
      digest: digestBuilder.digest('hex'),
      files: [],
      seasons: new Map(),
      teams: new Map(),
      players: new Map(),
      matches: new Map(),
      warnings: [],
      errors: [],
    };

    for (const file of sortedFiles) {
      if (!file.originalname.toLowerCase().endsWith('.json')) {
        normalized.errors.push(`${file.originalname}: 只支持 .json 文件`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        normalized.errors.push(`${file.originalname}: 文件超过 2MB 限制`);
        continue;
      }

      let value: unknown;
      try {
        value = JSON.parse(file.buffer.toString('utf8'));
      } catch {
        normalized.errors.push(`${file.originalname}: JSON 格式无效或不是 UTF-8 编码`);
        continue;
      }
      const document = asRecord(value);
      if (!document) {
        normalized.errors.push(`${file.originalname}: 顶层必须是 JSON 对象`);
        continue;
      }

      if (Array.isArray(document.rawFiles) && Array.isArray(document.seasons)) {
        normalized.files.push({ name: file.originalname, type: 'manifest' });
        normalized.warnings.push(`${file.originalname}: 清单文件仅用于核对，不写入数据库`);
        continue;
      }
      if (document.assignmentStatus === 'not_assigned_to_historical_season') {
        normalized.files.push({ name: file.originalname, type: 'supplemental' });
        this.readTeams(document.teams, null, normalized, file.originalname);
        continue;
      }

      const season = asRecord(document.season);
      const seasonName = text(season?.name);
      if (!seasonName || !Array.isArray(document.teams) || !Array.isArray(document.matches)) {
        normalized.errors.push(`${file.originalname}: 不是受支持的分赛季历史数据文件`);
        continue;
      }
      if (normalized.seasons.has(seasonName)) {
        normalized.errors.push(`${file.originalname}: 赛季 ${seasonName} 重复上传`);
        continue;
      }

      normalized.files.push({ name: file.originalname, type: 'season', season: seasonName });
      normalized.seasons.set(seasonName, { name: seasonName });
      this.readTeams(document.teams, seasonName, normalized, file.originalname);
      this.readMatches(document.matches, seasonName, normalized, file.originalname);
    }

    if (normalized.seasons.size === 0 && normalized.players.size === 0) {
      normalized.errors.push('没有识别到可导入的赛季或球员数据');
    }
    if (normalized.players.size > 0) {
      normalized.warnings.unshift(
        'HIST-前缀为自动化生成的补全学号，避免因历史名单无学号而破坏现有系统约束',
      );
    }

    return normalized;
  }

  private static readTeams(
    rawTeams: unknown,
    seasonName: string | null,
    normalized: NormalizedPackage,
    filename: string,
  ): void {
    if (!Array.isArray(rawTeams)) return;

    for (const rawTeam of rawTeams) {
      const record = asRecord(rawTeam);
      const teamName = text(record?.name);
      if (!teamName) {
        normalized.warnings.push(`${filename}: 存在没有名称的球队记录，已跳过`);
        continue;
      }

      const existingTeam = normalized.teams.get(teamName) || {
        name: teamName,
        seasonNames: new Set<string>(),
      };
      if (seasonName) existingTeam.seasonNames.add(seasonName);
      normalized.teams.set(teamName, existingTeam);

      if (Array.isArray(record?.players)) {
        for (const rawPlayer of record.players) {
          const playerRecord = asRecord(rawPlayer);
          const playerName = text(playerRecord?.name);
          if (!playerName) continue;

          const jerseyNumbers = Array.isArray(playerRecord?.jerseyNumbers)
            ? playerRecord.jerseyNumbers.map(text).filter(Boolean)
            : [];
          const jerseyNumber = jerseyNumbers[0] || UNKNOWN_JERSEY;

          const pKey = this.playerKey(teamName, playerName, seasonName);
          const legacyKey = seasonName
            ? `history:${seasonName}:${teamName}:${playerName}`
            : `history:supplemental:${teamName}:${playerName}`;

          const playerObj: NormalizedPlayer = {
            key: pKey,
            legacyKey,
            name: playerName,
            teamName,
            jerseyNumber: String(jerseyNumber),
            seasonName,
          };
          normalized.players.set(pKey, playerObj);
        }
      }
    }
  }

  private static readMatches(
    rawMatches: unknown[],
    seasonName: string,
    normalized: NormalizedPackage,
    filename: string,
  ): void {
    for (const rawMatch of rawMatches) {
      const matchRecord = asRecord(rawMatch);
      const gameId = text(matchRecord?.gameId);
      const homeTeam = text(matchRecord?.homeTeam);
      const awayTeam = text(matchRecord?.awayTeam);
      const date = text(matchRecord?.date);

      if (!gameId || !homeTeam || !awayTeam || !date) {
        normalized.warnings.push(`${filename}: 存在关键属性缺失的比赛记录，已跳过`);
        continue;
      }

      const legacyGameId = `history:${seasonName}:${gameId}`;
      const mKey = this.matchKey(gameId, seasonName);
      if (normalized.matches.has(mKey)) {
        normalized.warnings.push(`${filename}: 比赛 ${gameId} 在赛季 ${seasonName} 中重复，已跳过`);
        continue;
      }

      const events: NormalizedEvent[] = [];
      if (Array.isArray(matchRecord?.events)) {
        this.readEvents(matchRecord.events, false, homeTeam, awayTeam, events);
      }
      const penaltyShootout = asRecord(matchRecord?.penaltyShootout);
      if (penaltyShootout && Array.isArray(penaltyShootout.kicks)) {
        this.readEvents(penaltyShootout.kicks, true, homeTeam, awayTeam, events);
      }

      const normalizedMatch: NormalizedMatch = {
        key: mKey,
        legacyGameId,
        gameId,
        seasonName,
        date,
        time: text(matchRecord?.time),
        round: text(matchRecord?.round),
        group: text(matchRecord?.group),
        homeTeam,
        awayTeam,
        homeScore: integer(matchRecord?.homeScore),
        awayScore: integer(matchRecord?.awayScore),
        homePenaltyScore: integer(penaltyShootout?.homeScore),
        awayPenaltyScore: integer(penaltyShootout?.awayScore),
        events,
      };
      normalized.matches.set(mKey, normalizedMatch);
    }
  }

  private static readEvents(
    rawEvents: unknown[],
    isShootout: boolean,
    homeTeam: string,
    awayTeam: string,
    target: NormalizedEvent[],
  ): void {
    for (const rawEvent of rawEvents) {
      const record = asRecord(rawEvent);
      if (!record) continue;

      const event = this.normalizeEvent(record, isShootout, homeTeam, awayTeam);
      if (event) target.push(event);
    }
  }

  private static normalizeEvent(
    record: JsonRecord,
    isShootout: boolean,
    homeTeam: string,
    awayTeam: string,
  ): NormalizedEvent | null {
    const rawType = text(record.eventType);
    let eventType: string | null = null;

    if (isShootout) {
      const scored = record.scored === true;
      eventType = scored ? 'penalty_shootout_goal' : 'penalty_shootout_miss';
    } else if (rawType) {
      eventType = HISTORY_EVENT_TYPES[rawType.toLowerCase()] || HISTORY_EVENT_TYPES[rawType] || null;
    }

    if (!eventType) return null;

    const teamTypeRaw = text(record.teamType);
    let teamType: 'home' | 'away' = 'home';
    let teamName = homeTeam;

    if (teamTypeRaw === 'away' || text(record.teamName) === awayTeam) {
      teamType = 'away';
      teamName = awayTeam;
    }

    const eventId = text(record.eventId) || stableHash(`${teamName}:${eventType}:${record.time || ''}`);
    const eventTime = text(record.time) || (isShootout ? '点球大战' : '0');

    return {
      eventId,
      eventTime,
      eventType,
      phase: isShootout ? 'SHOOTOUT' : 'REGULAR',
      shootoutRound: integer(record.shootoutRound ?? record.round),
      shootoutOrder: integer(record.shootoutOrder ?? record.order),
      teamType,
      teamName,
      playerName: text(record.playerName),
      jerseyNumber: text(record.jerseyNumber),
    };
  }
}
