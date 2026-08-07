-- Repair a partially applied migration left by concurrent preview deployments.
-- Keep this migration idempotent so it is safe when the original migration succeeded.
CREATE TABLE IF NOT EXISTS "AdminFormDraft" (
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

CREATE INDEX IF NOT EXISTS "AdminFormDraft_formType_status_updatedAt_idx"
ON "AdminFormDraft"("formType", "status", "updatedAt");

CREATE INDEX IF NOT EXISTS "AdminFormDraft_username_updatedAt_idx"
ON "AdminFormDraft"("username", "updatedAt");

CREATE INDEX IF NOT EXISTS "AdminFormDraft_officialRecordId_idx"
ON "AdminFormDraft"("officialRecordId");
