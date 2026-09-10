-- AlterTable: 7 张可变业务表补齐时间戳字段
ALTER TABLE "Goal" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "MatchEvent" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "HistoryImportBatch" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "SeasonDeletionApproval" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "SeasonTeamPlayer" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "MatchLineup" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "SeasonGroupTeam" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: 扩充 BackupRun 运行历史字段
ALTER TABLE "BackupRun" ADD COLUMN "fingerprintBefore" TEXT,
ADD COLUMN "fingerprintAfter" TEXT,
ADD COLUMN "peakRssBytes" BIGINT;

-- CreateTable: 业务模块增量检查点与指纹基线
CREATE TABLE "BackupModuleCheckpoint" (
    "id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "selectorKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "fingerprintVersion" INTEGER NOT NULL DEFAULT 1,
    "lastSuccessfulBackupKey" TEXT,
    "lastSuccessfulAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupModuleCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackupModuleCheckpoint_module_selectorKey_key" ON "BackupModuleCheckpoint"("module", "selectorKey");
CREATE INDEX "BackupModuleCheckpoint_selectorKey_idx" ON "BackupModuleCheckpoint"("selectorKey");

-- 预置全局 Gate 行锁记录
INSERT INTO "BackupLock" ("id", "lockKey", "createdAt", "updatedAt")
VALUES ('backup-global-gate', 'lock:backup:gate', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("lockKey") DO NOTHING;

-- 原生触发器函数: 使用 clock_timestamp() 保证长事务中取得真实物理执行时刻
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  -- 普通 UPDATE 未显式修改 updatedAt 时自动刷新；备份恢复显式写回
  -- 历史 updatedAt 时保留备份值，保证恢复后的数据深度一致。
  IF current_setting('sztufa.preserve_updated_at', true) IS DISTINCT FROM 'on'
     AND NEW."updatedAt" IS NOT DISTINCT FROM OLD."updatedAt" THEN
    NEW."updatedAt" = clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为全部 21 张可变持久化表安装 BEFORE UPDATE 原生触发器 (采用完整标识符 %I 安全转义)
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'User', 'MemberAccount', 'Team', 'Player', 'Season', 'Match', 'Prediction',
    'Goal', 'MatchEvent', 'News', 'SeasonTeamProfile', 'HistoryImportBatch',
    'SeasonDeletionApproval', 'SeasonTeamPlayer', 'MatchLineup', 'SeasonGroupTeam',
    'PdfImportBatch', 'AdminFormDraft', 'TeamRegistration', 'RegistrationTeamData', 'RegistrationPlayer'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I;', 'trigger_set_timestamp_' || t, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();', 'trigger_set_timestamp_' || t, t);
  END LOOP;
END $$;
