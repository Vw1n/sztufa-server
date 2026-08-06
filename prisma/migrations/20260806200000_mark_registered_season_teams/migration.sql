-- Historical migrations created placeholder profiles for every team in every
-- season. Registration must be explicit so placeholders do not appear as
-- participants in group configuration and team management.
ALTER TABLE "SeasonTeamProfile"
ADD COLUMN IF NOT EXISTS "isRegistered" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "SeasonTeamProfile" profile
SET "isRegistered" = TRUE
WHERE EXISTS (
  SELECT 1 FROM "SeasonGroupTeam" grouped
  WHERE grouped."seasonId" = profile."seasonId"
    AND grouped."teamId" = profile."teamId"
)
OR EXISTS (
  SELECT 1 FROM "Match" match
  WHERE match."seasonId" = profile."seasonId"
    AND (match."homeTeamId" = profile."teamId" OR match."awayTeamId" = profile."teamId")
);

CREATE INDEX IF NOT EXISTS "SeasonTeamProfile_seasonId_isRegistered_idx"
ON "SeasonTeamProfile"("seasonId", "isRegistered");
