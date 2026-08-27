ALTER TABLE "CampusCardAsset" ADD COLUMN "uploadSettled" BOOLEAN NOT NULL DEFAULT true;
-- 旧暂存记录无法证明写入已结束，保守保留配额并持续清理。
UPDATE "CampusCardAsset" SET "uploadSettled" = false WHERE "state" IN ('STAGING', 'DELETE_PENDING') AND "memberId" IS NULL;
