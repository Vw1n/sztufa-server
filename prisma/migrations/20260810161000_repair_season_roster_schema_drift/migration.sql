-- Repair databases whose migration history says the season roster migrations
-- were applied even though the corresponding columns are absent.
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
    AND (
      match."homeTeamId" = profile."teamId"
      OR match."awayTeamId" = profile."teamId"
    )
);

CREATE INDEX IF NOT EXISTS "SeasonTeamProfile_seasonId_isRegistered_idx"
ON "SeasonTeamProfile"("seasonId", "isRegistered");

ALTER TABLE "SeasonTeamPlayer"
ADD COLUMN IF NOT EXISTS "studentId" TEXT;

UPDATE "SeasonTeamPlayer" roster
SET "studentId" = player."studentId"
FROM "Player" player
WHERE player."id" = roster."playerId"
  AND roster."studentId" IS NULL;

ALTER TABLE "SeasonTeamPlayer"
ALTER COLUMN "studentId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "SeasonTeamPlayer_seasonId_studentId_idx"
ON "SeasonTeamPlayer"("seasonId", "studentId");
