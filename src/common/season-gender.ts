export type TeamGender = 'MALE' | 'FEMALE';

export function getSeasonGender(seasonName: string): TeamGender | null {
  if (seasonName.includes('女')) {
    return 'FEMALE';
  }
  if (seasonName.includes('男')) {
    return 'MALE';
  }
  return null;
}

export function isTeamGenderCompatibleWithSeason(seasonName: string, teamGender: string): boolean {
  const seasonGender = getSeasonGender(seasonName);
  return seasonGender === null || seasonGender === teamGender;
}
