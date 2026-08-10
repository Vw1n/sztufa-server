export type TeamGender = 'MALE' | 'FEMALE';

export function getSeasonGender(seasonName: string): TeamGender | null {
  if (seasonName.includes('女') || seasonName.includes('女子')) {
    return 'FEMALE';
  }
  if (seasonName.includes('男') || seasonName.includes('男子')) {
    return 'MALE';
  }
  return null;
}

export function isTeamGenderCompatibleWithSeason(seasonName: string, teamGender: string): boolean {
  const seasonGender = getSeasonGender(seasonName);
  return seasonGender === null || seasonGender === teamGender;
}
