-- CreateTable
CREATE TABLE "HistoryImportBatch" (
    "id" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "summary" JSONB NOT NULL,
    "undoPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "HistoryImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HistoryImportBatch_status_createdAt_idx"
ON "HistoryImportBatch"("status", "createdAt");
