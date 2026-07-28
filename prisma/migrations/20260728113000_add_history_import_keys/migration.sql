-- AlterTable
ALTER TABLE "Player" ADD COLUMN "legacyKey" TEXT;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN "legacyGameId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Player_legacyKey_key" ON "Player"("legacyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Match_legacyGameId_key" ON "Match"("legacyGameId");
