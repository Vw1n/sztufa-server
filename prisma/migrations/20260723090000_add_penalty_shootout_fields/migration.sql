-- Ensure MatchEvent table exists if migrating from clean database init
CREATE TABLE IF NOT EXISTS "MatchEvent" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "eventTime" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "teamType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchEvent_pkey" PRIMARY KEY ("id")
);

-- Add nullable match outcome fields first so older API versions remain compatible.
ALTER TABLE "Match"
ADD COLUMN "homePenaltyScore" INTEGER,
ADD COLUMN "awayPenaltyScore" INTEGER,
ADD COLUMN "winnerTeamId" TEXT,
ADD COLUMN "decidedBy" TEXT;

-- Existing events are regular-time events unless explicitly migrated later.
ALTER TABLE "MatchEvent"
ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'REGULAR',
ADD COLUMN "shootoutRound" INTEGER,
ADD COLUMN "shootoutOrder" INTEGER;

CREATE INDEX "MatchEvent_matchId_phase_shootoutOrder_idx"
ON "MatchEvent"("matchId", "phase", "shootoutOrder");
