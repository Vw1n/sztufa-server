-- CreateEnum
CREATE TYPE "PredictionChoice" AS ENUM ('HOME_WIN', 'DRAW', 'AWAY_WIN');

-- CreateEnum
CREATE TYPE "PredictionStatus" AS ENUM ('PENDING', 'CORRECT', 'WRONG', 'VOID');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "studentId" TEXT,
ADD COLUMN "nickname" TEXT;

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "choice" "PredictionChoice" NOT NULL,
    "status" "PredictionStatus" NOT NULL DEFAULT 'PENDING',
    "awardedPoints" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_studentId_key" ON "User"("studentId");

-- CreateIndex
CREATE INDEX "User_studentId_idx" ON "User"("studentId");

-- CreateIndex
CREATE INDEX "Prediction_matchId_choice_idx" ON "Prediction"("matchId", "choice");

-- CreateIndex
CREATE INDEX "Prediction_userId_status_idx" ON "Prediction"("userId", "status");

-- CreateIndex
CREATE INDEX "Prediction_settledAt_idx" ON "Prediction"("settledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Prediction_userId_matchId_key" ON "Prediction"("userId", "matchId");

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
