-- CreateTable
CREATE TABLE "BackupBatch" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "targetSeasonId" TEXT,
    "status" TEXT NOT NULL,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "items" JSONB,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackupBatch_periodKey_key" ON "BackupBatch"("periodKey");
