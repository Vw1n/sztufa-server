CREATE TABLE IF NOT EXISTS "SeasonTeamPlayer" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonTeamPlayer_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SeasonTeamPlayer"
ADD COLUMN IF NOT EXISTS "playerName" TEXT,
ADD COLUMN IF NOT EXISTS "jerseyNumber" TEXT,
ADD COLUMN IF NOT EXISTS "playerPhoto" TEXT;

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
