-- AlterTable
ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "manualChampionTeamId" TEXT,
ADD COLUMN IF NOT EXISTS "manualChampionSetBy" TEXT,
ADD COLUMN IF NOT EXISTS "manualChampionSetAt" TIMESTAMP(3);
