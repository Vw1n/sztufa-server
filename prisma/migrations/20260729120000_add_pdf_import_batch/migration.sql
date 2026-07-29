-- CreateEnum
CREATE TYPE "PdfImportBatchStatus" AS ENUM ('PREVIEW', 'COMMITTING', 'COMMITTED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "PdfImportBatch" (
    "id" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "status" "PdfImportBatchStatus" NOT NULL DEFAULT 'PREVIEW',
    "previewData" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "commitStartedAt" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "finalObjectKeys" JSONB,
    "cleanupRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PdfImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PdfImportBatch_username_status_idx" ON "PdfImportBatch"("username", "status");

-- CreateIndex
CREATE INDEX "PdfImportBatch_expiresAt_idx" ON "PdfImportBatch"("expiresAt");

-- CreateIndex
CREATE INDEX "PdfImportBatch_fileHash_idx" ON "PdfImportBatch"("fileHash");
