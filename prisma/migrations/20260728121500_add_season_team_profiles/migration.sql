-- CreateTable
CREATE TABLE "SeasonTeamProfile" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "teamDoctor" TEXT,
    "headCoach" TEXT,
    "teamLeader" TEXT,
    "coachPhone" TEXT,
    "leaderPhone" TEXT,
    "homeJerseyColor" TEXT NOT NULL,
    "awayJerseyColor" TEXT NOT NULL,
    "teamLogo" TEXT,
    "homeJersey" TEXT,
    "awayJersey" TEXT,
    "gender" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeasonTeamProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeasonTeamProfile_seasonId_teamId_key"
ON "SeasonTeamProfile"("seasonId", "teamId");

-- CreateIndex
CREATE INDEX "SeasonTeamProfile_seasonId_idx" ON "SeasonTeamProfile"("seasonId");

-- CreateIndex
CREATE INDEX "SeasonTeamProfile_teamId_idx" ON "SeasonTeamProfile"("teamId");

-- AddForeignKey
ALTER TABLE "SeasonTeamProfile"
ADD CONSTRAINT "SeasonTeamProfile_seasonId_fkey"
FOREIGN KEY ("seasonId") REFERENCES "Season"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonTeamProfile"
ADD CONSTRAINT "SeasonTeamProfile_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "Team"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
