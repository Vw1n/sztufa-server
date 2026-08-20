-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED');

-- CreateTable
CREATE TABLE "TeamRegistration" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewComment" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationTeamData" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
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
    "gender" TEXT NOT NULL DEFAULT 'MALE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationTeamData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationPlayer" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "playerId" TEXT,
    "name" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "jerseyNumber" TEXT NOT NULL,
    "photo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamRegistration_seasonId_status_updatedAt_idx" ON "TeamRegistration"("seasonId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "TeamRegistration_teamId_idx" ON "TeamRegistration"("teamId");

-- CreateIndex
CREATE INDEX "TeamRegistration_submittedById_idx" ON "TeamRegistration"("submittedById");

-- CreateIndex
CREATE INDEX "TeamRegistration_reviewedById_idx" ON "TeamRegistration"("reviewedById");

-- CreateIndex
CREATE UNIQUE INDEX "TeamRegistration_seasonId_teamId_key" ON "TeamRegistration"("seasonId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationTeamData_registrationId_key" ON "RegistrationTeamData"("registrationId");

-- CreateIndex
CREATE INDEX "RegistrationPlayer_registrationId_idx" ON "RegistrationPlayer"("registrationId");

-- CreateIndex
CREATE INDEX "RegistrationPlayer_playerId_idx" ON "RegistrationPlayer"("playerId");

-- AddForeignKey
ALTER TABLE "TeamRegistration" ADD CONSTRAINT "TeamRegistration_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRegistration" ADD CONSTRAINT "TeamRegistration_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRegistration" ADD CONSTRAINT "TeamRegistration_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRegistration" ADD CONSTRAINT "TeamRegistration_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationTeamData" ADD CONSTRAINT "RegistrationTeamData_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "TeamRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationPlayer" ADD CONSTRAINT "RegistrationPlayer_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "TeamRegistration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationPlayer" ADD CONSTRAINT "RegistrationPlayer_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
