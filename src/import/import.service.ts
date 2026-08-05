import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SeasonStatisticsService } from '../prisma/season-statistics.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { resolveMatchOutcome } from '../match/match-outcome';
import {
  ImportExecutionResult,
  ImportPreview,
  ImportUndoPayload,
  LastImportBatch,
  UndoImportResult,
} from './import.types';
import { DEFAULT_LOCATION, UNKNOWN_JERSEY, ImportParser, stableHash } from './import-parser';
import { ImportWriter, getImportTransactionOptions } from './import-writer';

export type {
  ImportEntityCounts,
  ImportExecutionResult,
  ImportPreview,
  LastImportBatch,
  UndoImportResult,
} from './import.types';

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seasonStatistics: SeasonStatisticsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async previewFiles(files: Express.Multer.File[]): Promise<ImportPreview> {
    const normalized = ImportParser.normalizeFiles(files);
    const records = ImportParser.countRecords(normalized);
    const create = ImportParser.emptyCounts();
    const update = ImportParser.emptyCounts();

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
            legacyKey: {
              in: [...normalized.players.values()].map((player) => player.legacyKey),
            },
          },
          select: { legacyKey: true },
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
      const existingPlayers = new Set(players.map((player) => player.legacyKey).filter(Boolean));
      const existingMatches = new Set(matches.map((match) => match.legacyGameId).filter(Boolean));

      create.seasons = records.seasons - existingSeasons.size;
      update.seasons = existingSeasons.size;
      create.teams = records.teams - existingTeams.size;
      update.teams = existingTeams.size;
      for (const player of normalized.players.values()) {
        if (existingPlayers.has(player.legacyKey)) {
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
      canImport:
        normalized.errors.length === 0 && records.seasons + records.players + records.matches > 0,
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
    const normalized = ImportParser.normalizeFiles(files);
    if (normalized.errors.length > 0) {
      throw new BadRequestException(normalized.errors);
    }
    if (expectedDigest && normalized.digest !== expectedDigest) {
      throw new BadRequestException('文件内容已发生变化，请重新预检后再导入');
    }

    const created = ImportParser.emptyCounts();
    const updated = ImportParser.emptyCounts();
    const importedSeasons = new Map<string, string>();
    const undoPayload = this.emptyUndoPayload();

    await this.prisma.$transaction(async (tx) => {
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
          undoPayload.created.seasonIds.push(season.id);
          created.seasons += 1;
        }
        const seasonId = seasonIds.get(seasonInput.name);
        if (seasonId && !undoPayload.affectedSeasonIds.includes(seasonId)) {
          undoPayload.affectedSeasonIds.push(seasonId);
        }
      }

      const teamIds = new Map<string, string>();
      for (const teamInput of normalized.teams.values()) {
        const existing = await tx.team.findUnique({ where: { teamName: teamInput.name } });
        if (existing) {
          undoPayload.updated.teams.push({
            id: existing.id,
            deletedAt: existing.deletedAt?.toISOString() || null,
          });
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
          undoPayload.created.teamIds.push(team.id);
          created.teams += 1;
        }
      }

      for (const teamInput of normalized.teams.values()) {
        const teamId = teamIds.get(teamInput.name);
        if (!teamId) {
          throw new BadRequestException(`球队不存在: ${teamInput.name}`);
        }
        for (const seasonName of teamInput.seasonNames) {
          const seasonId = seasonIds.get(seasonName);
          if (!seasonId) {
            throw new BadRequestException(`赛季不存在: ${seasonName}`);
          }
          const existingProfile = await tx.seasonTeamProfile.findUnique({
            where: {
              seasonId_teamId: {
                seasonId,
                teamId,
              },
            },
            select: { id: true },
          });
          const profile = await tx.seasonTeamProfile.upsert({
            where: {
              seasonId_teamId: {
                seasonId,
                teamId,
              },
            },
            create: {
              seasonId,
              teamId,
              teamName: teamInput.name,
              teamDoctor: null,
              headCoach: null,
              teamLeader: null,
              coachPhone: null,
              leaderPhone: null,
              homeJerseyColor: UNKNOWN_JERSEY,
              awayJerseyColor: UNKNOWN_JERSEY,
              teamLogo: null,
              homeJersey: null,
              awayJersey: null,
              gender: seasonName.includes('女') ? 'FEMALE' : 'MALE',
            },
            update: {},
          });
          if (!existingProfile) {
            undoPayload.created.profileIds.push(profile.id);
          }
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
          undoPayload.updated.players.push({
            id: player.id,
            name: player.name,
            jerseyNumber: player.jerseyNumber,
            teamId: player.teamId,
            deletedAt: player.deletedAt?.toISOString() || null,
          });
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
          undoPayload.created.playerIds.push(player.id);
          created.players += 1;
        }
        playerIds.set(playerInput.key, player.id);

        if (playerInput.seasonName) {
          const seasonId = seasonIds.get(playerInput.seasonName);
          if (!seasonId) {
            throw new BadRequestException(`赛季不存在: ${playerInput.seasonName}`);
          }
          const existingRosterLink = await tx.seasonTeamPlayer.findUnique({
            where: {
              seasonId_playerId: {
                seasonId,
                playerId: player.id,
              },
            },
            select: {
              id: true,
              teamId: true,
              playerName: true,
              jerseyNumber: true,
              playerPhoto: true,
            },
          });
          const rosterLink = await tx.seasonTeamPlayer.upsert({
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
              playerName: playerInput.name,
              jerseyNumber: playerInput.jerseyNumber,
              playerPhoto: null,
            },
            update: {
              teamId,
              playerName: playerInput.name,
              jerseyNumber: playerInput.jerseyNumber,
              playerPhoto: null,
            },
          });
          if (existingRosterLink) {
            undoPayload.updated.rosterLinks.push(existingRosterLink);
          } else {
            undoPayload.created.rosterLinkIds.push(rosterLink.id);
          }
        }
      }

      for (const matchInput of normalized.matches.values()) {
        const seasonId = seasonIds.get(matchInput.seasonName);
        const homeTeamId = teamIds.get(matchInput.homeTeam);
        const awayTeamId = teamIds.get(matchInput.awayTeam);
        if (!seasonId || !homeTeamId || !awayTeamId) {
          throw new BadRequestException(`比赛关联数据不完整: ${matchInput.gameId}`);
        }

        const status = ImportWriter.resolveStatus(matchInput);
        const matchDate = ImportWriter.parseMatchDate(matchInput.date, matchInput.time);
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
        const competition = ImportWriter.resolveCompetition(matchInput);
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
          include: { goals: true, events: true },
        });
        if (existing) {
          undoPayload.updated.matches.push(
            ImportWriter.snapshotMatch(existing, existing.goals, existing.events),
          );
        }
        const match = existing
          ? await tx.match.update({ where: { id: existing.id }, data: matchData })
          : await tx.match.create({ data: matchData });
        if (existing) updated.matches += 1;
        else {
          undoPayload.created.matchIds.push(match.id);
          created.matches += 1;
        }

        await tx.goal.deleteMany({ where: { matchId: match.id } });
        await tx.matchEvent.deleteMany({ where: { matchId: match.id } });

        const eventRows = matchInput.events.map((event) => {
          const eventTeamName =
            event.teamName ||
            (event.teamType === 'home' ? matchInput.homeTeam : matchInput.awayTeam);
          const playerId = event.playerName
            ? playerIds.get(
                ImportParser.playerKey(eventTeamName, event.playerName, matchInput.seasonName),
              ) || null
            : null;
          return {
            matchId: match.id,
            eventTime: event.eventTime,
            eventType: event.eventType,
            phase: event.phase,
            shootoutRound: event.shootoutRound,
            shootoutOrder: event.shootoutOrder,
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
      await tx.historyImportBatch.create({
        data: {
          digest: normalized.digest,
          username,
          summary: {
            digest: normalized.digest,
            created,
            updated,
            warnings: normalized.warnings,
          } as any,
          undoPayload: undoPayload as any,
        },
      });
    }, getImportTransactionOptions());

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
        normalized.warnings.push(`${seasonName}: 数据已导入，但统计缓存刷新失败，可稍后重新计算`);
      }
    }

    return {
      digest: normalized.digest,
      created,
      updated,
      warnings: normalized.warnings,
    };
  }

  async getLastImport(): Promise<LastImportBatch | null> {
    const batch = await this.prisma.historyImportBatch.findFirst({
      where: { status: 'completed' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        digest: true,
        username: true,
        status: true,
        summary: true,
        createdAt: true,
      },
    });
    return batch ? ({ ...batch, summary: batch.summary as any } as LastImportBatch) : null;
  }

  async undoLastImport(username: string): Promise<UndoImportResult> {
    const warnings: string[] = [];
    const batch = await this.prisma.historyImportBatch.findFirst({
      where: { status: 'completed' },
      orderBy: { createdAt: 'desc' },
    });
    if (!batch) {
      throw new BadRequestException('没有可撤销的历史 JSON 导入记录');
    }

    const payload = batch.undoPayload as unknown as ImportUndoPayload;
    await this.prisma.$transaction(async (tx) => {
      if (payload.created.matchIds.length > 0) {
        await tx.match.deleteMany({ where: { id: { in: payload.created.matchIds } } });
      }

      for (const snapshot of payload.updated.matches) {
        await tx.goal.deleteMany({ where: { matchId: snapshot.id } });
        await tx.matchEvent.deleteMany({ where: { matchId: snapshot.id } });
        await tx.match.update({
          where: { id: snapshot.id },
          data: ImportWriter.restoreMatchData(snapshot.data),
        });
        if (snapshot.goals.length > 0) {
          await tx.goal.createMany({ data: snapshot.goals as any });
        }
        if (snapshot.events.length > 0) {
          await tx.matchEvent.createMany({ data: snapshot.events as any });
        }
      }

      if (payload.created.rosterLinkIds.length > 0) {
        await tx.seasonTeamPlayer.deleteMany({
          where: { id: { in: payload.created.rosterLinkIds } },
        });
      }
      for (const rosterLink of payload.updated.rosterLinks) {
        await tx.seasonTeamPlayer.update({
          where: { id: rosterLink.id },
          data: {
            teamId: rosterLink.teamId,
            playerName: rosterLink.playerName,
            jerseyNumber: rosterLink.jerseyNumber,
            playerPhoto: rosterLink.playerPhoto,
          },
        });
      }

      if (payload.created.profileIds.length > 0) {
        await tx.seasonTeamProfile.deleteMany({
          where: { id: { in: payload.created.profileIds } },
        });
      }

      for (const player of payload.updated.players) {
        await tx.player.update({
          where: { id: player.id },
          data: {
            name: player.name,
            jerseyNumber: player.jerseyNumber,
            teamId: player.teamId,
            deletedAt: player.deletedAt ? new Date(player.deletedAt) : null,
          },
        });
      }
      if (payload.created.playerIds.length > 0) {
        await tx.player.deleteMany({ where: { id: { in: payload.created.playerIds } } });
      }

      for (const team of payload.updated.teams) {
        await tx.team.update({
          where: { id: team.id },
          data: { deletedAt: team.deletedAt ? new Date(team.deletedAt) : null },
        });
      }
      if (payload.created.teamIds.length > 0) {
        const deletedTeams = await tx.team.deleteMany({
          where: {
            id: { in: payload.created.teamIds },
            players: { none: {} },
            homeMatches: { none: {} },
            awayMatches: { none: {} },
            users: { none: {} },
            seasonPlayers: { none: {} },
            groupTeams: { none: {} },
            seasonProfiles: { none: {} },
          },
        });
        if (deletedTeams.count !== payload.created.teamIds.length) {
          warnings.push('部分本批次新建球队已有其他关联数据，已保留这些球队');
        }
      }

      if (payload.created.seasonIds.length > 0) {
        const deletedSeasons = await tx.season.deleteMany({
          where: {
            id: { in: payload.created.seasonIds },
            matches: { none: {} },
            teamPlayers: { none: {} },
            groupTeams: { none: {} },
            teamProfiles: { none: {} },
          },
        });
        if (deletedSeasons.count !== payload.created.seasonIds.length) {
          warnings.push('部分本批次新建赛季已有其他关联数据，已保留这些赛季');
        }
      }

      await tx.historyImportBatch.update({
        where: { id: batch.id },
        data: { status: 'undone', undoneAt: new Date() },
      });
      await this.auditLogService.log(
        username,
        'UNDO_HISTORY_JSON_IMPORT',
        `撤销历史 JSON 导入批次 ${batch.id}`,
        tx,
      );
    }, getImportTransactionOptions());

    for (const seasonId of payload.affectedSeasonIds) {
      const season = await this.prisma.season.findUnique({
        where: { id: seasonId },
        select: { id: true },
      });
      if (season) {
        const result = await this.seasonStatistics.computeAndCache(season.id);
        if (!result.success) {
          warnings.push(`赛季 ${season.id} 已撤销，但统计缓存刷新失败`);
        }
      }
    }

    return {
      batchId: batch.id,
      affectedSeasons: payload.affectedSeasonIds.length,
      restoredMatches: payload.updated.matches.length,
      deletedMatches: payload.created.matchIds.length,
      restoredPlayers: payload.updated.players.length,
      deletedPlayers: payload.created.playerIds.length,
      warnings,
    };
  }

  private emptyUndoPayload(): ImportUndoPayload {
    return {
      affectedSeasonIds: [],
      created: {
        seasonIds: [],
        teamIds: [],
        profileIds: [],
        playerIds: [],
        rosterLinkIds: [],
        matchIds: [],
      },
      updated: {
        teams: [],
        players: [],
        rosterLinks: [],
        matches: [],
      },
    };
  }
}
