import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ImportEntityCounts, JsonRecord, NormalizedEvent, NormalizedPackage } from './import.types';

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
  const normalizedText = String(value).trim();
  return normalizedText || null;
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
    return `${seasonName || '未归季'}\u0000${teamName}\u0000${playerName}`;
  }

  static matchKey(gameId: string, seasonName: string): string {
    return `${seasonName}\u0000${gameId}`;
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
        '历史 JSON 不含真实学号；新建球员会使用稳定的 HIST- 占位学号，后续可在球员管理中补录。',
      );
    }

    return normalized;
  }

  private static registerTeam(
    normalized: NormalizedPackage,
    teamName: string,
    seasonName: string | null,
  ): void {
    let team = normalized.teams.get(teamName);
    if (!team) {
      team = { name: teamName, seasonNames: new Set() };
      normalized.teams.set(teamName, team);
    }
    if (seasonName) {
      team.seasonNames.add(seasonName);
    }
  }

  private static readTeams(
    input: unknown,
    seasonName: string | null,
    normalized: NormalizedPackage,
    fileName: string,
  ): void {
    if (!Array.isArray(input)) {
      normalized.errors.push(`${fileName}: teams 必须是数组`);
      return;
    }

    for (const teamValue of input) {
      const team = asRecord(teamValue);
      const teamName = text(team?.name);
      if (!teamName || !team) {
        normalized.errors.push(`${fileName}: 存在缺少名称的球队`);
        continue;
      }

      this.registerTeam(normalized, teamName, seasonName);
      if (!Array.isArray(team.players)) continue;

      for (const playerValue of team.players) {
        const player = asRecord(playerValue);
        const playerName = text(player?.name);
        if (!playerName || !player) {
          normalized.warnings.push(`${fileName}/${teamName}: 跳过缺少姓名的球员`);
          continue;
        }

        const key = this.playerKey(teamName, playerName, seasonName);
        let playerInput = normalized.players.get(key);
        if (!playerInput) {
          const jerseyNumbers = Array.isArray(player.jerseyNumbers)
            ? player.jerseyNumbers.map(text).filter(Boolean)
            : [text(player.jerseyNumber)].filter(Boolean);
          const jerseyNumber = (jerseyNumbers[0] as string | undefined) || UNKNOWN_JERSEY;
          if (jerseyNumber === UNKNOWN_JERSEY) {
            normalized.warnings.push(`${teamName}/${playerName}: 缺少号码，将标记为“未记录”`);
          }

          playerInput = {
            key,
            legacyKey: `history:${stableHash(key)}`,
            name: playerName,
            teamName,
            jerseyNumber,
            seasonName,
          };
          normalized.players.set(key, playerInput);
        }
      }
    }
  }

  private static readMatches(
    input: unknown,
    seasonName: string,
    normalized: NormalizedPackage,
    fileName: string,
  ): void {
    if (!Array.isArray(input)) {
      normalized.errors.push(`${fileName}: matches 必须是数组`);
      return;
    }

    for (const matchValue of input) {
      const match = asRecord(matchValue);
      const gameId = text(match?.gameId);
      const homeTeam = text(match?.homeTeam);
      const awayTeam = text(match?.awayTeam);
      const date = text(match?.date);

      if (!match || !gameId || !homeTeam || !awayTeam || !date) {
        normalized.errors.push(`${fileName}: 存在缺少编号、球队或日期的比赛`);
        continue;
      }

      const key = `${seasonName}\u0000${gameId}`;
      if (normalized.matches.has(key)) {
        normalized.errors.push(`${fileName}: 比赛 ${gameId} 重复`);
        continue;
      }

      this.registerTeam(normalized, homeTeam, seasonName);
      this.registerTeam(normalized, awayTeam, seasonName);

      const penalty = asRecord(match.penaltyShootout);
      const regularEvents = Array.isArray(match.events) ? match.events : [];
      const shootoutEvents = Array.isArray(penalty?.events)
        ? penalty.events
        : Array.isArray(penalty?.kicks)
          ? penalty.kicks
          : [];

      const events: NormalizedEvent[] = [];
      for (const [index, eventValue] of [...regularEvents, ...shootoutEvents].entries()) {
        const event = asRecord(eventValue);
        const rawType = text(event?.eventType);
        const fromShootout = index >= regularEvents.length;
        const scored = event?.scored;
        const mappedType = rawType
          ? HISTORY_EVENT_TYPES[rawType]
          : fromShootout && typeof scored === 'boolean'
            ? scored
              ? 'penalty_shootout_goal'
              : 'penalty_shootout_miss'
            : null;
        const teamType = event?.teamType;
        if (!event || !mappedType || (teamType !== 'home' && teamType !== 'away')) {
          normalized.warnings.push(`${seasonName}/${gameId}: 跳过无法识别的第 ${index + 1} 条事件`);
          continue;
        }

        const isShootout = fromShootout || mappedType.startsWith('penalty_shootout_');
        const shootoutOrder = isShootout
          ? integer(event.shootoutOrder ?? event.order) ||
            events.filter((item) => item.phase === 'SHOOTOUT').length + 1
          : null;

        events.push({
          eventId: text(event.eventId) || `${key}:${index + 1}`,
          eventTime: text(event.time) || '未记录',
          eventType: mappedType,
          phase: isShootout ? 'SHOOTOUT' : 'REGULAR',
          shootoutRound: isShootout
            ? integer(event.shootoutRound ?? event.round) || Math.ceil(shootoutOrder! / 2)
            : null,
          shootoutOrder,
          teamType,
          teamName: text(event.teamName) || (teamType === 'home' ? homeTeam : awayTeam),
          playerName: text(event.playerName),
          jerseyNumber: text(event.jerseyNumber),
        });
      }

      normalized.matches.set(key, {
        key,
        legacyGameId: `history:${stableHash(key)}`,
        gameId,
        seasonName,
        date,
        time: text(match.time),
        round: text(match.round),
        group: text(match.group),
        homeTeam,
        awayTeam,
        homeScore: integer(match.homeScore),
        awayScore: integer(match.awayScore),
        homePenaltyScore: integer(penalty?.homeScore),
        awayPenaltyScore: integer(penalty?.awayScore),
        events,
      });
    }
  }
}
