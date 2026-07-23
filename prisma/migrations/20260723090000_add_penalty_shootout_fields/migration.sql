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
