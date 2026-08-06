-- Student IDs are editable registration data and must be isolated per season,
-- just like player names, jersey numbers, and photos.
ALTER TABLE "SeasonTeamPlayer"
ADD COLUMN "studentId" TEXT;

UPDATE "SeasonTeamPlayer" roster
SET "studentId" = player."studentId"
FROM "Player" player
WHERE player."id" = roster."playerId";

ALTER TABLE "SeasonTeamPlayer"
ALTER COLUMN "studentId" SET NOT NULL;

CREATE INDEX "SeasonTeamPlayer_seasonId_studentId_idx"
ON "SeasonTeamPlayer"("seasonId", "studentId");
