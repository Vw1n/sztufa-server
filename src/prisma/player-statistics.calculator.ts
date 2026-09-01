import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export interface PlayerStat {
  playerId: string;
  playerName: string;
  jerseyNumber: string;
  teamName: string;
  teamLogo: string;
}

export interface ScorerStat extends PlayerStat {
  goals: number;
  penaltyGoals: number;
}

export interface AssistStat extends PlayerStat {
  assists: number;
}

export interface CardStat extends PlayerStat {
  yellowCards: number;
  redCards: number;
}

export interface PlayerStatistics {
  scorers: ScorerStat[];
  assists: AssistStat[];
  cards: CardStat[];
}

@Injectable()
export class PlayerStatisticsCalculator {
  constructor(private readonly prisma: PrismaService) {}

  async calculate(
    matches: any[],
    databaseTeams: Map<string, any>,
    seasonId?: string,
  ): Promise<PlayerStatistics> {
    const scorers = new Map<string, ScorerStat>();
    const assists = new Map<string, AssistStat>();
    const cards = new Map<string, CardStat>();
    const referencedPlayerIds = new Set<string>();
    const referencedTeamIds = new Set<string>();

    const effectiveSeasonId = seasonId || matches.find((m) => m.seasonId)?.seasonId;

    matches.forEach((match) => {
      if (match.homeTeamId) referencedTeamIds.add(match.homeTeamId);
      if (match.awayTeamId) referencedTeamIds.add(match.awayTeamId);
      match.goals?.forEach((goal: any) => {
        if (goal.playerId) referencedPlayerIds.add(goal.playerId);
      });
      match.events?.forEach((event: any) => {
        if (event.playerId) referencedPlayerIds.add(event.playerId);
        if (event.assistPlayerId) referencedPlayerIds.add(event.assistPlayerId);
      });
    });

    const [seasonProfiles, seasonTeamPlayers, players] = await Promise.all([
      effectiveSeasonId && this.prisma.seasonTeamProfile
        ? this.prisma.seasonTeamProfile.findMany({
            where: { seasonId: effectiveSeasonId },
            select: { teamId: true, teamName: true, teamLogo: true },
          })
        : Promise.resolve([]),
      effectiveSeasonId && referencedPlayerIds.size > 0 && this.prisma.seasonTeamPlayer
        ? this.prisma.seasonTeamPlayer.findMany({
            where: {
              seasonId: effectiveSeasonId,
              playerId: { in: Array.from(referencedPlayerIds) },
            },
            select: {
              playerId: true,
              teamId: true,
              playerName: true,
              jerseyNumber: true,
              playerPhoto: true,
            },
          })
        : Promise.resolve([]),
      referencedPlayerIds.size > 0 && this.prisma.player
        ? this.prisma.player.findMany({
            where: { id: { in: Array.from(referencedPlayerIds) } },
            select: {
              id: true,
              name: true,
              jerseyNumber: true,
              teamId: true,
              team: { select: { id: true, teamName: true, teamLogo: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const seasonProfilesMap = new Map((seasonProfiles || []).map((p: any) => [p.teamId, p]));
    const seasonPlayersMap = new Map((seasonTeamPlayers || []).map((sp: any) => [sp.playerId, sp]));
    const playersMap = new Map((players || []).map((player: any) => [player.id, player]));

    const resolveTeamInfo = (teamId: string) => {
      const profile = seasonProfilesMap.get(teamId);
      if (profile && profile.teamName) {
        return {
          teamName: profile.teamName,
          teamLogo: profile.teamLogo || '',
        };
      }
      const dbTeam = databaseTeams?.get(teamId);
      if (dbTeam) {
        return {
          teamName: dbTeam.teamName || '',
          teamLogo: dbTeam.teamLogo || '',
        };
      }
      return {
        teamName: '',
        teamLogo: '',
      };
    };

    const getPlayerTeamInfo = (
      playerId: string | null,
      playerName: string,
      jerseyNumber: string,
      teamType: string,
      match: any,
    ) => {
      const seasonPlayer = playerId ? seasonPlayersMap.get(playerId) : null;
      const player = playerId ? playersMap.get(playerId) : null;

      // 1. 确定比赛事件发生时所属的球队 ID：
      // 优先取比赛中该事件指定的队别（主队或客队）
      let eventTeamId: string | null = null;
      if (teamType === 'home') {
        eventTeamId = match.homeTeamId;
      } else if (teamType === 'away') {
        eventTeamId = match.awayTeamId;
      } else {
        eventTeamId =
          seasonPlayer?.teamId || player?.teamId || match.homeTeamId || match.awayTeamId;
      }

      const teamInfo = eventTeamId ? resolveTeamInfo(eventTeamId) : { teamName: '', teamLogo: '' };

      // 2. 确定球员名称与号码
      const effectiveName =
        (seasonPlayer?.playerName && seasonPlayer.playerName.trim()) ||
        (player?.name && player.name.trim()) ||
        (playerName && playerName.trim()) ||
        '未知球员';

      const effectiveJersey =
        (jerseyNumber !== undefined && jerseyNumber !== null && String(jerseyNumber).trim() !== ''
          ? String(jerseyNumber).trim()
          : '') ||
        (seasonPlayer?.jerseyNumber && String(seasonPlayer.jerseyNumber).trim()) ||
        (player?.jerseyNumber && String(player.jerseyNumber).trim()) ||
        '';

      return {
        name: effectiveName,
        jersey: effectiveJersey,
        teamName: teamInfo.teamName,
        teamLogo: teamInfo.teamLogo,
      };
    };

    matches.forEach((match) => {
      match.goals?.forEach((goal: any) => {
        let cleanName = goal.playerName || '';
        const isPenaltyGoal = cleanName.endsWith(' (点球)');
        if (isPenaltyGoal) {
          cleanName = cleanName.substring(0, cleanName.length - 5);
        } else if (cleanName.endsWith(' (乌龙)')) {
          return;
        }

        const teamInfo = getPlayerTeamInfo(
          goal.playerId,
          cleanName,
          goal.jerseyNumber,
          goal.teamType,
          match,
        );

        const key = goal.playerId || `${teamInfo.name}_${teamInfo.jersey}_${teamInfo.teamName}`;
        const record = scorers.get(key) || {
          playerId: goal.playerId || '',
          playerName: teamInfo.name,
          jerseyNumber: teamInfo.jersey,
          teamName: teamInfo.teamName,
          teamLogo: teamInfo.teamLogo,
          goals: 0,
          penaltyGoals: 0,
        };
        record.goals += 1;
        if (isPenaltyGoal) record.penaltyGoals += 1;
        scorers.set(key, record);
      });

      match.events?.forEach((event: any) => {
        const teamInfo = getPlayerTeamInfo(
          event.playerId,
          event.playerName || '',
          event.jerseyNumber || '',
          event.teamType,
          match,
        );

        if (['yellow_card', 'red_card', 'yellow_to_red'].includes(event.eventType)) {
          const key = event.playerId || `${teamInfo.name}_${teamInfo.jersey}_${teamInfo.teamName}`;
          const record = cards.get(key) || {
            playerId: event.playerId || '',
            playerName: teamInfo.name,
            jerseyNumber: teamInfo.jersey,
            teamName: teamInfo.teamName,
            teamLogo: teamInfo.teamLogo,
            yellowCards: 0,
            redCards: 0,
          };
          if (event.eventType === 'yellow_card') record.yellowCards += 1;
          if (event.eventType === 'red_card' || event.eventType === 'yellow_to_red') {
            record.redCards += 1;
          }
          cards.set(key, record);
        }

        if (event.assistPlayerName || event.assistPlayerId) {
          const assistTeamInfo = getPlayerTeamInfo(
            event.assistPlayerId,
            event.assistPlayerName || '',
            event.assistJerseyNumber || '',
            event.teamType,
            match,
          );
          const key =
            event.assistPlayerId ||
            `${assistTeamInfo.name}_${assistTeamInfo.jersey}_${assistTeamInfo.teamName}`;
          const record = assists.get(key) || {
            playerId: event.assistPlayerId || '',
            playerName: assistTeamInfo.name,
            jerseyNumber: assistTeamInfo.jersey,
            teamName: assistTeamInfo.teamName,
            teamLogo: assistTeamInfo.teamLogo,
            assists: 0,
          };
          record.assists += 1;
          assists.set(key, record);
        }
      });
    });

    return {
      scorers: Array.from(scorers.values()).sort((a, b) => b.goals - a.goals),
      assists: Array.from(assists.values()).sort((a, b) => b.assists - a.assists),
      cards: Array.from(cards.values()).sort((a, b) => {
        if (b.redCards !== a.redCards) return b.redCards - a.redCards;
        return b.yellowCards - a.yellowCards;
      }),
    };
  }
}
