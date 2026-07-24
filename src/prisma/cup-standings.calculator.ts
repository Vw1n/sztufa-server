import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TeamStanding } from './league-standings.calculator';

@Injectable()
export class CupStandingsCalculator {
  constructor(private readonly prisma: PrismaService) {}

  async calculate(
    seasonId: string,
    seasonGender: string,
    matches: any[],
    databaseTeams: Map<string, any>,
  ): Promise<{ type: string; groups: Record<string, TeamStanding[]> }> {
    const groupTeams = await this.prisma.seasonGroupTeam.findMany({
      where: { seasonId },
      include: { team: true },
    });
    const groups = new Map<string, Map<string, TeamStanding>>();

    groupTeams.forEach((groupTeam) => {
      if (!groupTeam.team || groupTeam.team.gender !== seasonGender) return;
      if (!groups.has(groupTeam.groupName)) groups.set(groupTeam.groupName, new Map());
      groups
        .get(groupTeam.groupName)!
        .set(
          groupTeam.teamId,
          this.createStanding(
            groupTeam.teamId,
            groupTeam.team.teamName,
            groupTeam.team.teamLogo || '',
          ),
        );
    });

    matches
      .filter((match) => match.stage === 'GROUP')
      .forEach((match) => {
        const groupName = match.groupName || 'A';
        if (!groups.has(groupName)) groups.set(groupName, new Map());
        const groupStandings = groups.get(groupName)!;

        const ensureTeam = (teamId: string) => {
          if (groupStandings.has(teamId)) return;
          const team = databaseTeams.get(teamId);
          if (!team || team.gender !== seasonGender) return;
          groupStandings.set(
            teamId,
            this.createStanding(teamId, team.teamName || '未知球队', team.teamLogo || ''),
          );
        };
        ensureTeam(match.homeTeamId);
        ensureTeam(match.awayTeamId);
        this.applyMatchResult(
          groupStandings.get(match.homeTeamId),
          groupStandings.get(match.awayTeamId),
          match,
        );
      });

    const groupResults: Record<string, TeamStanding[]> = {};
    groups.forEach((groupStandings, groupName) => {
      groupResults[groupName] = Array.from(groupStandings.values()).sort(this.compareStandings);
    });
    return { type: 'CUP', groups: groupResults };
  }

  private createStanding(teamId: string, teamName: string, teamLogo: string): TeamStanding {
    return {
      teamId,
      teamName,
      teamLogo,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDifference: 0,
      points: 0,
    };
  }

  private applyMatchResult(
    home: TeamStanding | undefined,
    away: TeamStanding | undefined,
    match: any,
  ) {
    if (!home || !away) return;
    home.played += 1;
    away.played += 1;
    home.goalsFor += match.homeScore;
    home.goalsAgainst += match.awayScore;
    away.goalsFor += match.awayScore;
    away.goalsAgainst += match.homeScore;

    if (match.homeScore > match.awayScore) {
      home.won += 1;
      home.points += 3;
      away.lost += 1;
    } else if (match.homeScore < match.awayScore) {
      away.won += 1;
      away.points += 3;
      home.lost += 1;
    } else {
      home.drawn += 1;
      home.points += 1;
      away.drawn += 1;
      away.points += 1;
    }
    home.goalDifference = home.goalsFor - home.goalsAgainst;
    away.goalDifference = away.goalsFor - away.goalsAgainst;
  }

  private compareStandings(a: TeamStanding, b: TeamStanding): number {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
    return b.goalsFor - a.goalsFor;
  }
}
