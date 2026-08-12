export interface PublicPlayerDto {
  id: string;
  name: string;
  jerseyNumber: string;
  photo: string | null;
  status: string;
  yellowCards: number;
  redCards: number;
  teamId: string;
  team?: PublicTeamDto;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export interface PublicTeamDto {
  id: string;
  teamName: string;
  teamDoctor: string | null;
  headCoach: string | null;
  teamLeader: string | null;
  homeJerseyColor: string;
  awayJerseyColor: string;
  teamLogo: string | null;
  homeJersey: string | null;
  awayJersey: string | null;
  gender: string;
  players?: PublicPlayerDto[];
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export const publicTeamSelect = {
  id: true,
  teamName: true,
  teamDoctor: true,
  headCoach: true,
  teamLeader: true,
  homeJerseyColor: true,
  awayJerseyColor: true,
  teamLogo: true,
  homeJersey: true,
  awayJersey: true,
  gender: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const publicPlayerFieldsSelect = {
  id: true,
  name: true,
  jerseyNumber: true,
  photo: true,
  status: true,
  yellowCards: true,
  redCards: true,
  teamId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const publicPlayerSelect = {
  ...publicPlayerFieldsSelect,
  team: { select: publicTeamSelect },
} as const;

export function toPublicTeamDto(team: any): PublicTeamDto {
  if (!team) return team;
  const {
    id,
    teamName,
    teamDoctor,
    headCoach,
    teamLeader,
    homeJerseyColor,
    awayJerseyColor,
    teamLogo,
    homeJersey,
    awayJersey,
    gender,
    players,
    createdAt,
    updatedAt,
  } = team;

  return {
    id,
    teamName,
    teamDoctor: teamDoctor ?? null,
    headCoach: headCoach ?? null,
    teamLeader: teamLeader ?? null,
    homeJerseyColor,
    awayJerseyColor,
    teamLogo: teamLogo ?? null,
    homeJersey: homeJersey ?? null,
    awayJersey: awayJersey ?? null,
    gender: gender || 'MALE',
    players: Array.isArray(players) ? players.map(toPublicPlayerDto) : undefined,
    createdAt,
    updatedAt,
  };
}

export function toPublicPlayerDto(player: any): PublicPlayerDto {
  if (!player) return player;
  const {
    id,
    name,
    jerseyNumber,
    photo,
    status,
    yellowCards,
    redCards,
    teamId,
    team,
    createdAt,
    updatedAt,
  } = player;

  return {
    id,
    name,
    jerseyNumber,
    photo: photo ?? null,
    status: status || 'active',
    yellowCards: yellowCards ?? 0,
    redCards: redCards ?? 0,
    teamId,
    team: team ? toPublicTeamDto(team) : undefined,
    createdAt,
    updatedAt,
  };
}
