CREATE TABLE "SeasonDeletionApproval" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeasonDeletionApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeasonDeletionApproval_seasonId_approverId_key"
ON "SeasonDeletionApproval"("seasonId", "approverId");
CREATE INDEX "SeasonDeletionApproval_seasonId_idx"
ON "SeasonDeletionApproval"("seasonId");
CREATE INDEX "SeasonDeletionApproval_approverId_idx"
ON "SeasonDeletionApproval"("approverId");

ALTER TABLE "SeasonDeletionApproval"
ADD CONSTRAINT "SeasonDeletionApproval_seasonId_fkey"
FOREIGN KEY ("seasonId") REFERENCES "Season"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeasonDeletionApproval"
ADD CONSTRAINT "SeasonDeletionApproval_approverId_fkey"
FOREIGN KEY ("approverId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
