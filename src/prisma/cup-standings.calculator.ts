import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TeamStanding } from './league-standings.calculator';
import { getCanonicalWinnerTeamId } from '../match/winner-team-id';

@Injectable()
export class CupStandingsCalculator {
  constructor(private readonly prisma: PrismaService) {}

  async calculate(
    seasonId: string,
    seasonGender: string,
    matches: any[],
    databaseTeams: Map<string, any>,
  ): Promise<{ type: string; groups: Record<string, TeamStanding[]> }> {
    const [groupTeams, seasonProfiles] = await Promise.all([
      this.prisma.seasonGroupTeam.findMany({
        where: { seasonId },
        select: {
          teamId: true,
          groupName: true,
          team: { select: { teamName: true, teamLogo: true, gender: true } },
        },
      }),
      this.prisma.seasonTeamProfile
        ? this.prisma.seasonTeamProfile.findMany({
            where: { seasonId },
            select: { teamId: true, teamName: true, teamLogo: true, gender: true },
          })
        : Promise.resolve([]),
    ]);

    const seasonProfilesMap = new Map((seasonProfiles || []).map((p: any) => [p.teamId, p]));
    const groups = new Map<string, Map<string, TeamStanding>>();

    const resolveTeamInfo = (teamId: string, fallbackTeam?: any) => {
      const profile = seasonProfilesMap.get(teamId);
      if (profile) {
        return {
          teamName: profile.teamName,
          teamLogo: profile.teamLogo || '',
          gender: profile.gender,
        };
      }
      const dbTeam = fallbackTeam || databaseTeams.get(teamId);
      return {
        teamName: dbTeam?.teamName || '未知球队',
        teamLogo: dbTeam?.teamLogo || '',
        gender: dbTeam?.gender || 'MALE',
      };
    };

    groupTeams.forEach((groupTeam) => {
      const teamInfo = resolveTeamInfo(groupTeam.teamId, groupTeam.team);
      if (teamInfo.gender !== seasonGender) return;
      if (!groups.has(groupTeam.groupName)) groups.set(groupTeam.groupName, new Map());
      groups
        .get(groupTeam.groupName)!
        .set(
          groupTeam.teamId,
          this.createStanding(groupTeam.teamId, teamInfo.teamName, teamInfo.teamLogo),
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
          const teamInfo = resolveTeamInfo(teamId);
          if (teamInfo.gender !== seasonGender) return;
          groupStandings.set(
            teamId,
            this.createStanding(teamId, teamInfo.teamName, teamInfo.teamLogo),
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

  private getPenaltyWinner(match: any): 'home' | 'away' | null {
    const isPenaltyMatch =
      (match.homePenaltyScore !== null &&
        match.homePenaltyScore !== undefined &&
        match.awayPenaltyScore !== null &&
        match.awayPenaltyScore !== undefined) ||
      match.decidedBy === 'PENALTIES' ||
      (Array.isArray(match.events) &&
        match.events.some(
          (e: any) =>
            e.eventType === 'penalty_shootout_goal' || e.eventType === 'penalty_shootout_miss',
        ));

    if (!isPenaltyMatch) return null;

    const matchForStandings = {
      ...match,
      winnerTeamId: match.decidedBy === 'PENALTIES' ? match.winnerTeamId : null,
    };

    const winnerId = getCanonicalWinnerTeamId(matchForStandings);
    if (!winnerId) return null;
    if (winnerId === match.homeTeamId) return 'home';
    if (winnerId === match.awayTeamId) return 'away';
    return null;
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
      away.drawn += 1;
      const penaltyWinner = this.getPenaltyWinner(match);
      if (penaltyWinner === 'home') {
        home.points += 2;
        away.points += 0;
      } else if (penaltyWinner === 'away') {
        away.points += 2;
        home.points += 0;
      } else {
        home.points += 1;
        away.points += 1;
      }
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
