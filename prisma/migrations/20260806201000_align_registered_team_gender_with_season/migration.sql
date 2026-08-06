-- Shared legacy team records could overwrite the profile gender and hide a
-- legitimately registered team from its season filter. The season name is the
-- authoritative competition category for registered profiles.
UPDATE "SeasonTeamProfile" profile
SET "gender" = CASE
  WHEN season."name" LIKE '%女%' THEN 'FEMALE'
  ELSE 'MALE'
END
FROM "Season" season
WHERE profile."seasonId" = season."id"
  AND profile."isRegistered" = TRUE;
