import { Injectable } from '@nestjs/common';
import { getCanonicalWinnerTeamId } from '../match/winner-team-id';

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
  isTiedWithNext?: boolean;
}

@Injectable()
export class LeagueStandingsCalculator {
  calculate(
    matches: any[],
    teams: Map<string, { id: string; teamName: string; teamLogo: string }>,
  ): TeamStanding[] {
    const standingsMap = new Map<string, TeamStanding>();
    teams.forEach((team) => {
      standingsMap.set(team.id, this.createStanding(team.id, team.teamName, team.teamLogo));
    });

    const leagueMatches = matches.filter((match) => match.stage === 'LEAGUE' || !match.stage);
    leagueMatches.forEach((match) =>
      this.applyMatchResult(
        standingsMap.get(match.homeTeamId),
        standingsMap.get(match.awayTeamId),
        match,
      ),
    );

    const standings = Array.from(standingsMap.values());
    return this.sortStandingsWithMiniLeague(standings, leagueMatches);
  }

  private sortStandingsWithMiniLeague(
    standings: TeamStanding[],
    leagueMatches: any[],
  ): TeamStanding[] {
    // 1. 按 (points, goalDifference, goalsFor) 对球队分组
    const groupMap = new Map<string, TeamStanding[]>();
    standings.forEach((team) => {
      const key = `${team.points}_${team.goalDifference}_${team.goalsFor}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, []);
      }
      groupMap.get(key)!.push(team);
    });

    // 按常规三项进行组排序
    const sortedGroupKeys = Array.from(groupMap.keys()).sort((keyA, keyB) => {
      const [ptsA, gdA, gfA] = keyA.split('_').map(Number);
      const [ptsB, gdB, gfB] = keyB.split('_').map(Number);
      if (ptsB !== ptsA) return ptsB - ptsA;
      if (gdB !== gdA) return gdB - gdA;
      return gfB - gfA;
    });

    const finalStandings: TeamStanding[] = [];

    sortedGroupKeys.forEach((key) => {
      const group = groupMap.get(key)!;
      if (group.length === 1) {
        group[0].isTiedWithNext = false;
        finalStandings.push(group[0]);
        return;
      }

      // 对 >1 人的组提取相互交手小联赛
      const groupTeamIds = new Set(group.map((t) => t.teamId));
      const miniMatches = leagueMatches.filter(
        (m) => groupTeamIds.has(m.homeTeamId) && groupTeamIds.has(m.awayTeamId),
      );

      const miniStats = new Map<
        string,
        { miniPoints: number; miniGoalDiff: number; miniGoalsFor: number }
      >();
      group.forEach((t) =>
        miniStats.set(t.teamId, { miniPoints: 0, miniGoalDiff: 0, miniGoalsFor: 0 }),
      );

      miniMatches.forEach((m) => {
        const homeStat = miniStats.get(m.homeTeamId);
        const awayStat = miniStats.get(m.awayTeamId);
        if (!homeStat || !awayStat) return;

        homeStat.miniGoalsFor += m.homeScore;
        awayStat.miniGoalsFor += m.awayScore;

        if (m.homeScore > m.awayScore) {
          homeStat.miniPoints += 3;
        } else if (m.awayScore > m.homeScore) {
          awayStat.miniPoints += 3;
        } else {
          const penaltyWinner = this.getPenaltyWinner(m);
          if (penaltyWinner === 'home') {
            homeStat.miniPoints += 2;
          } else if (penaltyWinner === 'away') {
            awayStat.miniPoints += 2;
          } else {
            homeStat.miniPoints += 1;
            awayStat.miniPoints += 1;
          }
        }
      });

      group.forEach((t) => {
        const stat = miniStats.get(t.teamId)!;
        // 计算小联赛净胜球：在 miniMatches 中的进球减失球
        let goalsConceded = 0;
        miniMatches.forEach((m) => {
          if (m.homeTeamId === t.teamId) goalsConceded += m.awayScore;
          if (m.awayTeamId === t.teamId) goalsConceded += m.homeScore;
        });
        stat.miniGoalDiff = stat.miniGoalsFor - goalsConceded;
      });

      // 对组内球队按小联赛三项及稳定字典序排序
      group.sort((a, b) => {
        const statA = miniStats.get(a.teamId)!;
        const statB = miniStats.get(b.teamId)!;

        if (statB.miniPoints !== statA.miniPoints) return statB.miniPoints - statA.miniPoints;
        if (statB.miniGoalDiff !== statA.miniGoalDiff)
          return statB.miniGoalDiff - statA.miniGoalDiff;
        if (statB.miniGoalsFor !== statA.miniGoalsFor)
          return statB.miniGoalsFor - statA.miniGoalsFor;

        return a.teamName.localeCompare(b.teamName, 'zh-CN') || a.teamId.localeCompare(b.teamId);
      });

      // 判定邻近球队是否在小联赛后仍完全平局
      for (let i = 0; i < group.length; i++) {
        const current = group[i];
        const next = group[i + 1];

        if (next) {
          const statCurrent = miniStats.get(current.teamId)!;
          const statNext = miniStats.get(next.teamId)!;
          const isTied =
            statCurrent.miniPoints === statNext.miniPoints &&
            statCurrent.miniGoalDiff === statNext.miniGoalDiff &&
            statCurrent.miniGoalsFor === statNext.miniGoalsFor;
          current.isTiedWithNext = isTied;
        } else {
          current.isTiedWithNext = false;
        }

        finalStandings.push(current);
      }
    });

    return finalStandings;
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
}
