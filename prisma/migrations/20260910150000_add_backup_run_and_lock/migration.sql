-- AlterTable
ALTER TABLE "Season" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "batchId" TEXT,
    "taskKey" TEXT,
    "trigger" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "selectorKey" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "skipReason" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "backupKey" TEXT,
    "checksum" TEXT,
    "objectSize" BIGINT,
    "leaseToken" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "databaseRowsRead" INTEGER,
    "databaseBytesEstimated" BIGINT,
    "uncompressedBytes" BIGINT,
    "uploadedBytes" BIGINT,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupLock" (
    "id" TEXT NOT NULL,
    "lockKey" TEXT NOT NULL,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "holderInstance" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackupRun_taskKey_key" ON "BackupRun"("taskKey");

-- CreateIndex
CREATE INDEX "BackupRun_selectorKey_purpose_status_idx" ON "BackupRun"("selectorKey", "purpose", "status");

-- CreateIndex
CREATE INDEX "BackupRun_trigger_status_idx" ON "BackupRun"("trigger", "status");

-- CreateIndex
CREATE INDEX "BackupRun_createdAt_idx" ON "BackupRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BackupLock_lockKey_key" ON "BackupLock"("lockKey");
