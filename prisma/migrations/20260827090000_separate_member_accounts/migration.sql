BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "Prediction" p JOIN "User" u ON u.id=p."userId" WHERE u.role <> 'user') THEN
  RAISE EXCEPTION '存在工作人员历史竞猜，请先人工处理账号映射';
 END IF;
 IF EXISTS (SELECT 1 FROM "User" u WHERE u.role='user' AND (u."teamId" IS NOT NULL OR EXISTS (SELECT 1 FROM "SeasonDeletionApproval" a WHERE a."approverId"=u.id) OR EXISTS (SELECT 1 FROM "TeamRegistration" r WHERE r."submittedById"=u.id OR r."reviewedById"=u.id))) THEN
  RAISE EXCEPTION '普通用户存在后台业务引用，请先核实';
 END IF;
END $$;
-- DropForeignKey
ALTER TABLE "Prediction" DROP CONSTRAINT "Prediction_userId_fkey";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "role" SET DEFAULT 'match_scorer';

-- CreateTable
CREATE TABLE "MemberAccount" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "nickname" TEXT,
    "realName" TEXT,
    "requestedStudentId" TEXT,
    "studentId" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "verificationVersion" INTEGER NOT NULL DEFAULT 1,
    "reviewComment" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'web',
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampusCardAsset" (
    "id" TEXT NOT NULL,
    "memberId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "objectKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'STAGING',
    "deleteAfter" TIMESTAMP(3) NOT NULL,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampusCardAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthRateLimit" (
    "id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthRateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberAccount_username_key" ON "MemberAccount"("username");

-- CreateIndex
CREATE UNIQUE INDEX "MemberAccount_studentId_key" ON "MemberAccount"("studentId");

-- CreateIndex
CREATE INDEX "MemberAccount_verificationStatus_createdAt_idx" ON "MemberAccount"("verificationStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampusCardAsset_objectKey_key" ON "CampusCardAsset"("objectKey");

-- CreateIndex
CREATE INDEX "CampusCardAsset_state_nextAttemptAt_idx" ON "CampusCardAsset"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CampusCardAsset_memberId_version_idx" ON "CampusCardAsset"("memberId", "version");

-- CreateIndex
CREATE INDEX "AuthRateLimit_expiresAt_idx" ON "AuthRateLimit"("expiresAt");


INSERT INTO "MemberAccount" (id,username,password,nickname,"requestedStudentId","studentId","verificationStatus",source,"createdAt","updatedAt")
SELECT id,username,password,nickname,"studentId","studentId",'LEGACY','legacy_unknown',"createdAt","updatedAt" FROM "User" WHERE role='user';
DELETE FROM "User" WHERE role='user';
ALTER TABLE "User" ADD CONSTRAINT "User_staff_role_check" CHECK (role IN ('super_admin','coach','match_scorer','news_editor'));

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "MemberAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
