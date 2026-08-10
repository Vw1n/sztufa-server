export interface NormalizedMatchInput {
  homeTeamId: string;
  awayTeamId: string;
  seasonId?: string | null;
  homeScore: number;
  awayScore: number;
  homePenaltyScore?: number | null;
  awayPenaltyScore?: number | null;
  matchDate: Date;
  location: string;
  status: string;
  stage: string;
  groupName?: string | null;
  knockoutRound?: string | null;
  knockoutMatchIndex?: number | null;
  mvpPlayerId?: string | null;
  mvpPlayerName?: string | null;
}

export function normalizeMatchPayload(input: any): NormalizedMatchInput {
  const homeTeamId = typeof input?.homeTeamId === 'string' ? input.homeTeamId.trim() : '';
  const awayTeamId = typeof input?.awayTeamId === 'string' ? input.awayTeamId.trim() : '';
  const seasonId =
    typeof input?.seasonId === 'string' && input.seasonId.trim() !== ''
      ? input.seasonId.trim()
      : null;

  const homeScoreRaw = input?.homeScore ?? input?.homeTeamScore;
  const awayScoreRaw = input?.awayScore ?? input?.awayTeamScore;

  const homeScore =
    typeof homeScoreRaw === 'number' && !isNaN(homeScoreRaw)
      ? homeScoreRaw
      : typeof homeScoreRaw === 'string' && !isNaN(parseInt(homeScoreRaw, 10))
        ? parseInt(homeScoreRaw, 10)
        : 0;
  const awayScore =
    typeof awayScoreRaw === 'number' && !isNaN(awayScoreRaw)
      ? awayScoreRaw
      : typeof awayScoreRaw === 'string' && !isNaN(parseInt(awayScoreRaw, 10))
        ? parseInt(awayScoreRaw, 10)
        : 0;

  const homePenaltyScore =
    typeof input?.homePenaltyScore === 'number' && !isNaN(input.homePenaltyScore)
      ? input.homePenaltyScore
      : null;
  const awayPenaltyScore =
    typeof input?.awayPenaltyScore === 'number' && !isNaN(input.awayPenaltyScore)
      ? input.awayPenaltyScore
      : null;

  let matchDate = new Date();
  const rawDateStr = input?.matchDate || input?.matchTime;
  if (rawDateStr) {
    const parsed = new Date(rawDateStr);
    if (!isNaN(parsed.getTime())) {
      matchDate = parsed;
    }
  }

  const location = typeof input?.location === 'string' ? input.location.trim() : '';
  const status =
    typeof input?.status === 'string' && input.status.trim() !== ''
      ? input.status.trim()
      : 'scheduled';
  const stage =
    typeof input?.stage === 'string' && input.stage.trim() !== '' ? input.stage.trim() : 'LEAGUE';

  const groupName =
    typeof input?.groupName === 'string' && input.groupName.trim() !== ''
      ? input.groupName.trim()
      : null;
  const knockoutRound =
    typeof input?.knockoutRound === 'string' && input.knockoutRound.trim() !== ''
      ? input.knockoutRound.trim()
      : null;
  const knockoutMatchIndex =
    typeof input?.knockoutMatchIndex === 'number' && !isNaN(input.knockoutMatchIndex)
      ? input.knockoutMatchIndex
      : null;

  const mvpPlayerId =
    typeof input?.mvpPlayerId === 'string' && input.mvpPlayerId.trim() !== ''
      ? input.mvpPlayerId.trim()
      : null;
  const mvpPlayerName =
    typeof input?.mvpPlayerName === 'string' && input.mvpPlayerName.trim() !== ''
      ? input.mvpPlayerName.trim()
      : null;

  return {
    homeTeamId,
    awayTeamId,
    seasonId,
    homeScore,
    awayScore,
    homePenaltyScore,
    awayPenaltyScore,
    matchDate,
    location,
    status,
    stage,
    groupName,
    knockoutRound,
    knockoutMatchIndex,
    mvpPlayerId,
    mvpPlayerName,
  };
}
