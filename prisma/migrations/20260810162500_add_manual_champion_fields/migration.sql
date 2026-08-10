-- AlterTable
ALTER TABLE "Season" ADD COLUMN     "manualChampionTeamId" TEXT,
ADD COLUMN     "manualChampionSetBy" TEXT,
ADD COLUMN     "manualChampionSetAt" TIMESTAMP(3);
