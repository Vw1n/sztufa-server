-- CreateTable
CREATE TABLE "AdminFormDraft" (
    "id" TEXT NOT NULL,
    "formType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "seasonId" TEXT,
    "officialRecordId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lastError" TEXT,
    "username" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminFormDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminFormDraft_formType_status_updatedAt_idx" ON "AdminFormDraft"("formType", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "AdminFormDraft_username_updatedAt_idx" ON "AdminFormDraft"("username", "updatedAt");

-- CreateIndex
CREATE INDEX "AdminFormDraft_officialRecordId_idx" ON "AdminFormDraft"("officialRecordId");
