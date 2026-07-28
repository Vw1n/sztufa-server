ALTER TABLE "SeasonTeamPlayer"
ADD COLUMN "playerName" TEXT,
ADD COLUMN "jerseyNumber" TEXT,
ADD COLUMN "playerPhoto" TEXT;

UPDATE "SeasonTeamPlayer" AS roster
SET
  "playerName" = player."name",
  "jerseyNumber" = player."jerseyNumber",
  "playerPhoto" = player."photo"
FROM "Player" AS player
WHERE player."id" = roster."playerId";

ALTER TABLE "SeasonTeamPlayer"
ALTER COLUMN "playerName" SET NOT NULL,
ALTER COLUMN "jerseyNumber" SET NOT NULL;
