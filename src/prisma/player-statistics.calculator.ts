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

  async calculate(matches: any[], databaseTeams: Map<string, any>): Promise<PlayerStatistics> {
    const scorers = new Map<string, ScorerStat>();
    const assists = new Map<string, AssistStat>();
    const cards = new Map<string, CardStat>();
    const players = await this.prisma.player.findMany({ include: { team: true } });
    const playersMap = new Map(players.map((player) => [player.id, player]));

    const getPlayerTeamInfo = (
      playerId: string | null,
      playerName: string,
      jerseyNumber: string,
      teamType: string,
      match: any,
    ) => {
      const player = playerId ? playersMap.get(playerId) : null;
      if (player) {
        return {
          name: player.name,
          jersey: player.jerseyNumber,
          teamName: player.team.teamName,
          teamLogo: player.team.teamLogo || '',
        };
      }
      const teamId = teamType === 'home' ? match.homeTeamId : match.awayTeamId;
      const team = databaseTeams.get(teamId);
      return {
        name: playerName,
        jersey: jerseyNumber,
        teamName: team?.teamName || '',
        teamLogo: team?.teamLogo || '',
      };
    };

    matches.forEach((match) => {
      match.goals.forEach((goal: any) => {
        let cleanName = goal.playerName;
        if (cleanName.endsWith(' (点球)')) {
          cleanName = cleanName.substring(0, cleanName.length - 5);
        } else if (cleanName.endsWith(' (乌龙)')) {
          return;
        }

        const key = goal.playerId || `${cleanName}_${goal.jerseyNumber}`;
        const teamInfo = getPlayerTeamInfo(
          goal.playerId,
          cleanName,
          goal.jerseyNumber,
          goal.teamType,
          match,
        );
        const record = scorers.get(key) || {
          playerId: goal.playerId || '',
          playerName: teamInfo.name,
          jerseyNumber: teamInfo.jersey,
          teamName: teamInfo.teamName,
          teamLogo: teamInfo.teamLogo,
          goals: 0,
        };
        record.goals += 1;
        scorers.set(key, record);
      });

      match.events.forEach((event: any) => {
        const teamInfo = getPlayerTeamInfo(
          event.playerId,
          event.playerName || '',
          event.jerseyNumber || '',
          event.teamType,
          match,
        );

        if (['yellow_card', 'red_card', 'yellow_to_red'].includes(event.eventType)) {
          const key = event.playerId || `${teamInfo.name}_${teamInfo.jersey}`;
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

        if (event.assistPlayerName) {
          const assistTeamInfo = getPlayerTeamInfo(
            event.assistPlayerId,
            event.assistPlayerName,
            event.assistJerseyNumber || '',
            event.teamType,
            match,
          );
          const key = event.assistPlayerId || `${assistTeamInfo.name}_${assistTeamInfo.jersey}`;
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
