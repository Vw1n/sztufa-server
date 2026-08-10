-- AlterTable
ALTER TABLE "Season"
DROP COLUMN IF EXISTS "manualChampionTeamId",
DROP COLUMN IF EXISTS "manualChampionSetBy",
DROP COLUMN IF EXISTS "manualChampionSetAt";
