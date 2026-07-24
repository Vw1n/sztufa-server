import { Injectable } from '@nestjs/common';

export interface TeamStanding {
  teamId: string;
  teamName: string;
  teamLogo: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
}

@Injectable()
export class LeagueStandingsCalculator {
  calculate(
    matches: any[],
    teams: Map<string, { id: string; teamName: string; teamLogo: string }>,
  ): TeamStanding[] {
    const standings = new Map<string, TeamStanding>();
    teams.forEach((team) => {
      standings.set(team.id, this.createStanding(team.id, team.teamName, team.teamLogo));
    });

    matches
      .filter((match) => match.stage === 'LEAGUE' || !match.stage)
      .forEach((match) =>
        this.applyMatchResult(
          standings.get(match.homeTeamId),
          standings.get(match.awayTeamId),
          match,
        ),
      );

    return Array.from(standings.values()).sort(this.compareStandings);
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
