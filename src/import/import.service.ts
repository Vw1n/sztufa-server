import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SeasonStatisticsService } from '../prisma/season-statistics.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { resolveMatchOutcome } from '../match/match-outcome';

type JsonRecord = Record<string, any>;

interface NormalizedSeason {
  name: string;
}

interface NormalizedTeam {
  name: string;
}

interface NormalizedPlayer {
  key: string;
  legacyKey: string;
  name: string;
  teamName: string;
  jerseyNumber: string;
  seasonNames: Set<string>;
}

interface NormalizedEvent {
  eventId: string;
  eventTime: string;
  eventType: string;
  teamType: 'home' | 'away';
  teamName: string;
  playerName: string | null;
  jerseyNumber: string | null;
}

interface NormalizedMatch {
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

interface NormalizedPackage {
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

const MAX_FILES = 10;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LOCATION = '深圳技术大学足球场';
const UNKNOWN_JERSEY = '未记录';

const HISTORY_EVENT_TYPES: Record<string, string> = {
  进球: 'goal',
  '进球(点球)': 'penalty',
  乌龙: 'own_goal',
  乌龙球: 'own_goal',
  黄牌: 'yellow_card',
  红牌: 'red_card',
  失点: 'penalty_miss',
  点球罚丢: 'penalty_miss',
};

const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const text = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const integer = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const normalized = text(value);
  return normalized && /^\d+$/.test(normalized) ? Number(normalized) : null;
};

const stableHash = (value: string, length = 24): string =>
  createHash('sha256').update(value).digest('hex').slice(0, length);

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seasonStatistics: SeasonStatisticsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async previewFiles(files: Express.Multer.File[]): Promise<ImportPreview> {
    const normalized = this.normalizeFiles(files);
    const records = this.countRecords(normalized);
    const create = this.emptyCounts();
    const update = this.emptyCounts();

    if (normalized.errors.length === 0) {
      const [seasons, teams, players, matches] = await Promise.all([
        this.prisma.season.findMany({
          where: { name: { in: [...normalized.seasons.keys()] } },
          select: { name: true },
        }),
        this.prisma.team.findMany({
          where: { teamName: { in: [...normalized.teams.keys()] } },
          select: { teamName: true },
        }),
        this.prisma.player.findMany({
          where: {
            OR: [
              {
                legacyKey: {
                  in: [...normalized.players.values()].map((player) => player.legacyKey),
                },
              },
              {
                name: { in: [...normalized.players.values()].map((player) => player.name) },
                team: { teamName: { in: [...normalized.teams.keys()] } },
                deletedAt: null,
              },
            ],
          },
          select: {
            legacyKey: true,
            name: true,
            team: { select: { teamName: true } },
          },
        }),
        this.prisma.match.findMany({
          where: {
            legacyGameId: {
              in: [...normalized.matches.values()].map((match) => match.legacyGameId),
            },
          },
          select: { legacyGameId: true },
        }),
      ]);

      const existingSeasons = new Set(seasons.map((season) => season.name));
      const existingTeams = new Set(teams.map((team) => team.teamName));
      const existingPlayers = new Set(
        players.flatMap((player) => [
          ...(player.legacyKey ? [player.legacyKey] : []),
          this.playerKey(player.team.teamName, player.name),
        ]),
      );
      const existingMatches = new Set(matches.map((match) => match.legacyGameId).filter(Boolean));

      create.seasons = records.seasons - existingSeasons.size;
      update.seasons = existingSeasons.size;
      create.teams = records.teams - existingTeams.size;
      update.teams = existingTeams.size;
      for (const player of normalized.players.values()) {
        if (existingPlayers.has(player.legacyKey) || existingPlayers.has(player.key)) {
          update.players += 1;
        } else {
          create.players += 1;
        }
      }
      create.matches = records.matches - existingMatches.size;
      update.matches = existingMatches.size;
      for (const match of normalized.matches.values()) {
        if (existingMatches.has(match.legacyGameId)) {
          update.events += match.events.length;
        } else {
          create.events += match.events.length;
        }
      }
    }

    return {
      digest: normalized.digest,
      canImport: normalized.errors.length === 0 && records.seasons + records.players + records.matches > 0,
      files: normalized.files,
      records,
      create,
      update,
      warnings: normalized.warnings,
      errors: normalized.errors,
    };
  }

  async importFiles(
    files: Express.Multer.File[],
    username: string,
    expectedDigest?: string,
  ): Promise<ImportExecutionResult> {
    const normalized = this.normalizeFiles(files);
    if (normalized.errors.length > 0) {
      throw new BadRequestException(normalized.errors);
    }
    if (expectedDigest && normalized.digest !== expectedDigest) {
      throw new BadRequestException('文件内容已发生变化，请重新预检后再导入');
    }

    const created = this.emptyCounts();
    const updated = this.emptyCounts();
    const importedSeasons = new Map<string, string>();

    await this.prisma.$transaction(
      async (tx) => {
        const seasonIds = new Map<string, string>();
        for (const seasonInput of normalized.seasons.values()) {
          const existing = await tx.season.findUnique({ where: { name: seasonInput.name } });
          if (existing) {
            seasonIds.set(seasonInput.name, existing.id);
            updated.seasons += 1;
          } else {
            const season = await tx.season.create({
              data: {
                name: seasonInput.name,
                status: 'archived',
                type: 'CUP',
              },
            });
            seasonIds.set(seasonInput.name, season.id);
            importedSeasons.set(season.id, seasonInput.name);
            created.seasons += 1;
          }
        }

        const teamIds = new Map<string, string>();
        for (const teamInput of normalized.teams.values()) {
          const existing = await tx.team.findUnique({ where: { teamName: teamInput.name } });
          if (existing) {
            const team = await tx.team.update({
              where: { id: existing.id },
              data: { deletedAt: null },
            });
            teamIds.set(teamInput.name, team.id);
            updated.teams += 1;
          } else {
            const team = await tx.team.create({
              data: {
                teamName: teamInput.name,
                homeJerseyColor: '未记录',
                awayJerseyColor: '未记录',
                gender: 'MALE',
              },
            });
            teamIds.set(teamInput.name, team.id);
            created.teams += 1;
          }
        }

        const playerIds = new Map<string, string>();
        for (const playerInput of normalized.players.values()) {
          const teamId = teamIds.get(playerInput.teamName);
          if (!teamId) throw new BadRequestException(`球队不存在: ${playerInput.teamName}`);

          let player = await tx.player.findUnique({
            where: { legacyKey: playerInput.legacyKey },
          });
          if (player) {
            player = await tx.player.update({
              where: { id: player.id },
              data: {
                name: playerInput.name,
                jerseyNumber: playerInput.jerseyNumber,
                teamId,
                deletedAt: null,
              },
            });
            updated.players += 1;
          } else {
            const manualPlayer = await tx.player.findFirst({
              where: {
                teamId,
                name: playerInput.name,
                deletedAt: null,
              },
            });
            if (manualPlayer) {
              player = await tx.player.update({
                where: { id: manualPlayer.id },
                data: { legacyKey: playerInput.legacyKey },
              });
              updated.players += 1;
            } else {
              player = await tx.player.create({
                data: {
                  name: playerInput.name,
                  studentId: `HIST-${stableHash(playerInput.legacyKey, 16).toUpperCase()}`,
                  legacyKey: playerInput.legacyKey,
                  jerseyNumber: playerInput.jerseyNumber,
                  photo: null,
                  teamId,
                },
              });
              created.players += 1;
            }
          }
          playerIds.set(playerInput.key, player.id);

          for (const seasonName of playerInput.seasonNames) {
            const seasonId = seasonIds.get(seasonName);
            if (!seasonId) continue;
            await tx.seasonTeamPlayer.upsert({
              where: {
                seasonId_playerId: {
                  seasonId,
                  playerId: player.id,
                },
              },
              create: {
                seasonId,
                teamId,
                playerId: player.id,
              },
              update: { teamId },
            });
          }
        }

        for (const matchInput of normalized.matches.values()) {
          const seasonId = seasonIds.get(matchInput.seasonName);
          const homeTeamId = teamIds.get(matchInput.homeTeam);
          const awayTeamId = teamIds.get(matchInput.awayTeam);
          if (!seasonId || !homeTeamId || !awayTeamId) {
            throw new BadRequestException(`比赛关联数据不完整: ${matchInput.gameId}`);
          }

          const status = this.resolveStatus(matchInput);
          const matchDate = this.parseMatchDate(matchInput.date, matchInput.time);
          const homeScore = matchInput.homeScore ?? 0;
          const awayScore = matchInput.awayScore ?? 0;
          const outcome =
            status === 'finished'
              ? resolveMatchOutcome(
                  homeScore,
                  awayScore,
                  matchInput.homePenaltyScore,
                  matchInput.awayPenaltyScore,
                )
              : null;
          const winnerTeamId =
            outcome?.winnerTeamType === 'home'
              ? homeTeamId
              : outcome?.winnerTeamType === 'away'
                ? awayTeamId
                : null;
          const competition = this.resolveCompetition(matchInput);
          const matchData = {
            legacyGameId: matchInput.legacyGameId,
            homeTeamId,
            awayTeamId,
            homeScore,
            awayScore,
            homePenaltyScore: matchInput.homePenaltyScore,
            awayPenaltyScore: matchInput.awayPenaltyScore,
            winnerTeamId,
            decidedBy: outcome?.decidedBy ?? null,
            matchDate,
            location: DEFAULT_LOCATION,
            status,
            seasonId,
            stage: competition.stage,
            groupName: competition.groupName,
            knockoutRound: competition.knockoutRound,
            deletedAt: null,
          };

          const existing = await tx.match.findUnique({
            where: { legacyGameId: matchInput.legacyGameId },
          });
          const match = existing
            ? await tx.match.update({ where: { id: existing.id }, data: matchData })
            : await tx.match.create({ data: matchData });
          if (existing) updated.matches += 1;
          else created.matches += 1;

          await tx.goal.deleteMany({ where: { matchId: match.id } });
          await tx.matchEvent.deleteMany({ where: { matchId: match.id } });

          const eventRows = matchInput.events.map((event) => {
            const eventTeamName =
              event.teamName ||
              (event.teamType === 'home' ? matchInput.homeTeam : matchInput.awayTeam);
            const playerId = event.playerName
              ? playerIds.get(this.playerKey(eventTeamName, event.playerName)) || null
              : null;
            return {
              matchId: match.id,
              eventTime: event.eventTime,
              eventType: event.eventType,
              phase: 'REGULAR',
              description: [event.playerName, event.eventType].filter(Boolean).join(' '),
              teamType: event.teamType,
              playerId,
              playerName: event.playerName,
              jerseyNumber: event.jerseyNumber,
            };
          });
          if (eventRows.length > 0) {
            await tx.matchEvent.createMany({ data: eventRows });
            if (existing) updated.events += eventRows.length;
            else created.events += eventRows.length;
          }

          const goalRows = eventRows
            .filter((event) => ['goal', 'penalty', 'own_goal'].includes(event.eventType))
            .map((event) => ({
              matchId: match.id,
              playerId: event.playerId,
              playerName:
                event.eventType === 'own_goal'
                  ? `${event.playerName || ''} (乌龙)`
                  : event.eventType === 'penalty'
                    ? `${event.playerName || ''} (点球)`
                    : event.playerName || '',
              jerseyNumber: event.jerseyNumber || '',
              goalTime: event.eventTime,
              teamType:
                event.eventType === 'own_goal'
                  ? event.teamType === 'home'
                    ? 'away'
                    : 'home'
                  : event.teamType,
            }));
          if (goalRows.length > 0) {
            await tx.goal.createMany({ data: goalRows });
          }
        }

        await this.auditLogService.log(
          username,
          'IMPORT_HISTORY_JSON',
          `导入历史 JSON：${created.seasons + updated.seasons} 个赛季、${created.teams + updated.teams} 支球队、${created.players + updated.players} 名球员、${created.matches + updated.matches} 场比赛、${created.events + updated.events} 条事件`,
          tx,
        );
      },
      { maxWait: 10_000, timeout: 60_000 },
    );

    for (const seasonName of normalized.seasons.keys()) {
      const season = await this.prisma.season.findUnique({
        where: { name: seasonName },
        select: { id: true },
      });
      if (season) {
        importedSeasons.set(season.id, seasonName);
      }
    }
    for (const [seasonId, seasonName] of importedSeasons) {
      const cacheResult = await this.seasonStatistics.computeAndCache(seasonId);
      if (!cacheResult.success) {
        normalized.warnings.push(
          `${seasonName}: 数据已导入，但统计缓存刷新失败，可稍后重新计算`,
        );
      }
    }

    return {
      digest: normalized.digest,
      created,
      updated,
      warnings: normalized.warnings,
    };
  }

  private normalizeFiles(files: Express.Multer.File[]): NormalizedPackage {
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

  private readTeams(
    input: unknown,
    seasonName: string | null,
    normalized: NormalizedPackage,
    fileName: string,
  ) {
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
      normalized.teams.set(teamName, { name: teamName });
      if (!Array.isArray(team.players)) continue;

      for (const playerValue of team.players) {
        const player = asRecord(playerValue);
        const playerName = text(player?.name);
        if (!playerName || !player) {
          normalized.warnings.push(`${fileName}/${teamName}: 跳过缺少姓名的球员`);
          continue;
        }
        const key = this.playerKey(teamName, playerName);
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
            seasonNames: new Set(),
          };
          normalized.players.set(key, playerInput);
        }
        if (seasonName) playerInput.seasonNames.add(seasonName);
      }
    }
  }

  private readMatches(
    input: unknown,
    seasonName: string,
    normalized: NormalizedPackage,
    fileName: string,
  ) {
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

      normalized.teams.set(homeTeam, { name: homeTeam });
      normalized.teams.set(awayTeam, { name: awayTeam });
      const events: NormalizedEvent[] = [];
      for (const [index, eventValue] of (Array.isArray(match.events) ? match.events : []).entries()) {
        const event = asRecord(eventValue);
        const rawType = text(event?.eventType);
        const mappedType = rawType ? HISTORY_EVENT_TYPES[rawType] : null;
        const teamType = event?.teamType;
        if (!event || !mappedType || (teamType !== 'home' && teamType !== 'away')) {
          normalized.warnings.push(`${seasonName}/${gameId}: 跳过无法识别的第 ${index + 1} 条事件`);
          continue;
        }
        events.push({
          eventId: text(event.eventId) || `${key}:${index + 1}`,
          eventTime: text(event.time) || '未记录',
          eventType: mappedType,
          teamType,
          teamName:
            text(event.teamName) || (teamType === 'home' ? homeTeam : awayTeam),
          playerName: text(event.playerName),
          jerseyNumber: text(event.jerseyNumber),
        });
      }

      const penalty = asRecord(match.penaltyShootout);
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

  private countRecords(normalized: NormalizedPackage): ImportEntityCounts {
    return {
      seasons: normalized.seasons.size,
      teams: normalized.teams.size,
      players: normalized.players.size,
      matches: normalized.matches.size,
      events: [...normalized.matches.values()].reduce(
        (sum, match) => sum + match.events.length,
        0,
      ),
    };
  }

  private emptyCounts(): ImportEntityCounts {
    return { seasons: 0, teams: 0, players: 0, matches: 0, events: 0 };
  }

  private playerKey(teamName: string, playerName: string): string {
    return `${teamName}\u0000${playerName}`;
  }

  private parseMatchDate(date: string, time: string | null): Date {
    const dateMatch = date.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
    if (!dateMatch) throw new BadRequestException(`无法识别比赛日期: ${date}`);
    const timeMatch = (time || '').match(/(\d{1,2}):(\d{2})/);
    const hour = timeMatch ? Number(timeMatch[1]) : 0;
    const minute = timeMatch ? Number(timeMatch[2]) : 0;
    const [, year, month, day] = dateMatch;
    return new Date(
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
    );
  }

  private resolveStatus(match: NormalizedMatch): string {
    const note = `${match.time || ''} ${match.round || ''}`;
    if (match.homeScore === null || match.awayScore === null) {
      return note.includes('弃权') ? 'cancelled' : 'scheduled';
    }
    return 'finished';
  }

  private resolveCompetition(match: NormalizedMatch): {
    stage: string;
    groupName: string | null;
    knockoutRound: string | null;
  } {
    const round = match.round || '';
    const inferredGroup = match.group || round.match(/小组赛\s*([A-Z])组/i)?.[1] || null;
    if (inferredGroup || round.includes('小组')) {
      return { stage: 'GROUP', groupName: inferredGroup, knockoutRound: null };
    }
    if (/决赛|排位赛|淘汰赛|1\/4/.test(round)) {
      let knockoutRound = 'PLACEMENT';
      if (round.includes('1/4')) knockoutRound = 'QUARTER_FINAL';
      else if (round.includes('半决赛')) knockoutRound = 'SEMI_FINAL';
      else if (round === '决赛') knockoutRound = 'FINAL';
      else if (/三四名/.test(round)) knockoutRound = 'THIRD_PLACE';
      return { stage: 'KNOCKOUT', groupName: null, knockoutRound };
    }
    return { stage: 'LEAGUE', groupName: null, knockoutRound: null };
  }
}
