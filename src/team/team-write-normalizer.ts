export interface NormalizedTeamInput {
  teamName: string;
  gender: string;
  homeJerseyColor: string;
  awayJerseyColor: string;
  teamDoctor?: string | null;
  headCoach?: string | null;
  teamLeader?: string | null;
  coachPhone?: string | null;
  leaderPhone?: string | null;
  teamLogo?: string | null;
  homeJersey?: string | null;
  awayJersey?: string | null;
  players: NormalizedPlayerInput[];
}

export interface NormalizedPlayerInput {
  id?: string;
  name: string;
  studentId: string;
  jerseyNumber: string;
  photo?: string | null;
  status?: string;
}

export function normalizeTeamPayload(input: any): NormalizedTeamInput {
  const teamName = typeof input?.teamName === 'string' ? input.teamName.trim() : '';
  const homeJerseyColor =
    typeof input?.homeJerseyColor === 'string' ? input.homeJerseyColor.trim() : '';
  const awayJerseyColor =
    typeof input?.awayJerseyColor === 'string' ? input.awayJerseyColor.trim() : '';
  const gender = input?.gender === 'FEMALE' ? 'FEMALE' : 'MALE';

  const teamDoctor =
    typeof input?.teamDoctor === 'string' && input.teamDoctor.trim() !== ''
      ? input.teamDoctor.trim()
      : null;
  const headCoach =
    typeof input?.headCoach === 'string' && input.headCoach.trim() !== ''
      ? input.headCoach.trim()
      : null;
  const teamLeader =
    typeof input?.teamLeader === 'string' && input.teamLeader.trim() !== ''
      ? input.teamLeader.trim()
      : null;
  const coachPhone =
    typeof input?.coachPhone === 'string' && input.coachPhone.trim() !== ''
      ? input.coachPhone.trim()
      : null;
  const leaderPhone =
    typeof input?.leaderPhone === 'string' && input.leaderPhone.trim() !== ''
      ? input.leaderPhone.trim()
      : null;
  const teamLogo =
    typeof input?.teamLogo === 'string' && input.teamLogo.trim() !== ''
      ? input.teamLogo.trim()
      : null;
  const homeJersey =
    typeof input?.homeJersey === 'string' && input.homeJersey.trim() !== ''
      ? input.homeJersey.trim()
      : null;
  const awayJersey =
    typeof input?.awayJersey === 'string' && input.awayJersey.trim() !== ''
      ? input.awayJersey.trim()
      : null;

  const rawPlayers = Array.isArray(input?.players) ? input.players : [];
  const players: NormalizedPlayerInput[] = rawPlayers.map((p: any) => ({
    id:
      typeof p?.id === 'string' && p.id.trim() !== '' && !p.id.startsWith('temp-')
        ? p.id.trim()
        : undefined,
    name: typeof p?.name === 'string' ? p.name.trim() : '',
    studentId: typeof p?.studentId === 'string' ? p.studentId.trim() : '',
    jerseyNumber:
      typeof p?.jerseyNumber === 'string'
        ? p.jerseyNumber.trim()
        : typeof p?.jerseyNumber === 'number'
          ? String(p.jerseyNumber)
          : '',
    photo:
      typeof p?.photo === 'string' && p.photo.trim() !== ''
        ? p.photo.trim()
        : typeof p?.playerPhoto === 'string' && p.playerPhoto.trim() !== ''
          ? p.playerPhoto.trim()
          : null,
    status: typeof p?.status === 'string' && p.status.trim() !== '' ? p.status.trim() : 'active',
  }));

  return {
    teamName,
    gender,
    homeJerseyColor,
    awayJerseyColor,
    teamDoctor,
    headCoach,
    teamLeader,
    coachPhone,
    leaderPhone,
    teamLogo,
    homeJersey,
    awayJersey,
    players,
  };
}
