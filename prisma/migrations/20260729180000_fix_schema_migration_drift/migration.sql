-- 向前修复 Migration：完整补齐从空库迁移至当前 schema.prisma 所需的所有缺失表、字段、索引与外键约束
-- 支持幂等执行 (IF NOT EXISTS)，既可修补全新空库，也可无缝兼容已有数据库

-- 1. 创建缺失的基础数据表
CREATE TABLE IF NOT EXISTS "Season" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "type" TEXT NOT NULL DEFAULT 'LEAGUE',
    "standingsCache" JSONB,
    "statsCache" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MatchEvent" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "eventTime" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'REGULAR',
    "shootoutRound" INTEGER,
    "shootoutOrder" INTEGER,
    "playerId" TEXT,
    "playerName" TEXT,
    "jerseyNumber" TEXT,
    "subPlayerId" TEXT,
    "subPlayerName" TEXT,
    "subJerseyNumber" TEXT,
    "assistPlayerId" TEXT,
    "assistPlayerName" TEXT,
    "assistJerseyNumber" TEXT,
    "description" TEXT NOT NULL,
    "teamType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Goal" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT,
    "playerName" TEXT NOT NULL,
    "jerseyNumber" TEXT NOT NULL,
    "goalTime" TEXT NOT NULL,
    "teamType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "News" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "coverImage" TEXT,
    "wechatUrl" TEXT,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date" TEXT NOT NULL DEFAULT '',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "News_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SeasonTeamPlayer" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "playerName" TEXT NOT NULL DEFAULT '',
    "jerseyNumber" TEXT NOT NULL DEFAULT '',
    "playerPhoto" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonTeamPlayer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MatchLineup" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "teamType" TEXT NOT NULL,
    "lineupType" TEXT NOT NULL,

    CONSTRAINT "MatchLineup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SeasonGroupTeam" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonGroupTeam_pkey" PRIMARY KEY ("id")
);

-- 2. 补全既有表中缺失的列
ALTER TABLE "Team"
    ADD COLUMN IF NOT EXISTS "gender" TEXT NOT NULL DEFAULT 'MALE',
    ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

ALTER TABLE "Player"
    ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS "yellowCards" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "redCards" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "suspendedAtMatchId" TEXT,
    ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

ALTER TABLE "Match"
    ADD COLUMN IF NOT EXISTS "seasonId" TEXT,
    ADD COLUMN IF NOT EXISTS "mvpPlayerId" TEXT,
    ADD COLUMN IF NOT EXISTS "mvpPlayerName" TEXT,
    ADD COLUMN IF NOT EXISTS "stage" TEXT NOT NULL DEFAULT 'LEAGUE',
    ADD COLUMN IF NOT EXISTS "groupName" TEXT,
    ADD COLUMN IF NOT EXISTS "knockoutRound" TEXT,
    ADD COLUMN IF NOT EXISTS "knockoutMatchIndex" INTEGER,
    ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "teamId" TEXT;

-- MatchEvent 可能由历史 baseline.sql / db push 提前创建；CREATE TABLE IF NOT EXISTS
-- 不会为既有表补列，因此必须在创建索引前显式补齐。
ALTER TABLE "MatchEvent"
    ADD COLUMN IF NOT EXISTS "phase" TEXT NOT NULL DEFAULT 'REGULAR',
    ADD COLUMN IF NOT EXISTS "shootoutRound" INTEGER,
    ADD COLUMN IF NOT EXISTS "shootoutOrder" INTEGER,
    ADD COLUMN IF NOT EXISTS "playerId" TEXT,
    ADD COLUMN IF NOT EXISTS "playerName" TEXT,
    ADD COLUMN IF NOT EXISTS "jerseyNumber" TEXT,
    ADD COLUMN IF NOT EXISTS "subPlayerId" TEXT,
    ADD COLUMN IF NOT EXISTS "subPlayerName" TEXT,
    ADD COLUMN IF NOT EXISTS "subJerseyNumber" TEXT,
    ADD COLUMN IF NOT EXISTS "assistPlayerId" TEXT,
    ADD COLUMN IF NOT EXISTS "assistPlayerName" TEXT,
    ADD COLUMN IF NOT EXISTS "assistJerseyNumber" TEXT;

-- 早期 init migration 使用 VARCHAR，当前 Prisma schema 使用 TEXT。
-- PostgreSQL 可无损扩大为 TEXT，统一类型以消除 schema drift。
ALTER TABLE "Team"
    ALTER COLUMN "teamName" TYPE TEXT,
    ALTER COLUMN "teamDoctor" TYPE TEXT,
    ALTER COLUMN "headCoach" TYPE TEXT,
    ALTER COLUMN "teamLeader" TYPE TEXT,
    ALTER COLUMN "coachPhone" TYPE TEXT,
    ALTER COLUMN "leaderPhone" TYPE TEXT,
    ALTER COLUMN "homeJerseyColor" TYPE TEXT,
    ALTER COLUMN "awayJerseyColor" TYPE TEXT;

ALTER TABLE "Player"
    ALTER COLUMN "name" TYPE TEXT,
    ALTER COLUMN "studentId" TYPE TEXT,
    ALTER COLUMN "jerseyNumber" TYPE TEXT;

ALTER TABLE "Match"
    ALTER COLUMN "location" TYPE TEXT,
    ALTER COLUMN "status" TYPE TEXT;

ALTER TABLE "User"
    ALTER COLUMN "username" TYPE TEXT,
    ALTER COLUMN "password" TYPE TEXT,
    ALTER COLUMN "role" TYPE TEXT;

-- 3. 创建索引与唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS "Season_name_key" ON "Season"("name");

CREATE INDEX IF NOT EXISTS "Team_deletedAt_idx" ON "Team"("deletedAt");

CREATE INDEX IF NOT EXISTS "Player_deletedAt_idx" ON "Player"("deletedAt");
CREATE INDEX IF NOT EXISTS "Player_teamId_deletedAt_idx" ON "Player"("teamId", "deletedAt");

CREATE INDEX IF NOT EXISTS "Match_seasonId_deletedAt_idx" ON "Match"("seasonId", "deletedAt");
CREATE INDEX IF NOT EXISTS "Match_seasonId_stage_deletedAt_idx" ON "Match"("seasonId", "stage", "deletedAt");
CREATE INDEX IF NOT EXISTS "Match_mvpPlayerId_idx" ON "Match"("mvpPlayerId");
CREATE INDEX IF NOT EXISTS "Match_deletedAt_idx" ON "Match"("deletedAt");

CREATE INDEX IF NOT EXISTS "User_teamId_idx" ON "User"("teamId");

CREATE INDEX IF NOT EXISTS "MatchEvent_matchId_idx" ON "MatchEvent"("matchId");
CREATE INDEX IF NOT EXISTS "MatchEvent_playerId_idx" ON "MatchEvent"("playerId");
CREATE INDEX IF NOT EXISTS "MatchEvent_subPlayerId_idx" ON "MatchEvent"("subPlayerId");
CREATE INDEX IF NOT EXISTS "MatchEvent_assistPlayerId_idx" ON "MatchEvent"("assistPlayerId");
CREATE INDEX IF NOT EXISTS "MatchEvent_matchId_eventTime_idx" ON "MatchEvent"("matchId", "eventTime");
CREATE INDEX IF NOT EXISTS "MatchEvent_matchId_phase_shootoutOrder_idx" ON "MatchEvent"("matchId", "phase", "shootoutOrder");

CREATE INDEX IF NOT EXISTS "Goal_matchId_idx" ON "Goal"("matchId");
CREATE INDEX IF NOT EXISTS "Goal_playerId_idx" ON "Goal"("playerId");

CREATE INDEX IF NOT EXISTS "News_category_idx" ON "News"("category");
CREATE INDEX IF NOT EXISTS "News_published_idx" ON "News"("published");
CREATE INDEX IF NOT EXISTS "News_publishedAt_idx" ON "News"("publishedAt");
CREATE INDEX IF NOT EXISTS "News_deletedAt_idx" ON "News"("deletedAt");

CREATE INDEX IF NOT EXISTS "AuditLog_username_idx" ON "AuditLog"("username");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "SeasonTeamPlayer_seasonId_playerId_key" ON "SeasonTeamPlayer"("seasonId", "playerId");
CREATE INDEX IF NOT EXISTS "SeasonTeamPlayer_seasonId_idx" ON "SeasonTeamPlayer"("seasonId");
CREATE INDEX IF NOT EXISTS "SeasonTeamPlayer_teamId_idx" ON "SeasonTeamPlayer"("teamId");
CREATE INDEX IF NOT EXISTS "SeasonTeamPlayer_playerId_idx" ON "SeasonTeamPlayer"("playerId");

CREATE UNIQUE INDEX IF NOT EXISTS "MatchLineup_matchId_playerId_key" ON "MatchLineup"("matchId", "playerId");
CREATE INDEX IF NOT EXISTS "MatchLineup_matchId_idx" ON "MatchLineup"("matchId");
CREATE INDEX IF NOT EXISTS "MatchLineup_playerId_idx" ON "MatchLineup"("playerId");

CREATE UNIQUE INDEX IF NOT EXISTS "SeasonGroupTeam_seasonId_teamId_key" ON "SeasonGroupTeam"("seasonId", "teamId");
CREATE INDEX IF NOT EXISTS "SeasonGroupTeam_seasonId_idx" ON "SeasonGroupTeam"("seasonId");
CREATE INDEX IF NOT EXISTS "SeasonGroupTeam_teamId_idx" ON "SeasonGroupTeam"("teamId");

-- 4. 安全补全外键约束
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_teamId_fkey') THEN
        ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Player_suspendedAtMatchId_fkey') THEN
        ALTER TABLE "Player" ADD CONSTRAINT "Player_suspendedAtMatchId_fkey" FOREIGN KEY ("suspendedAtMatchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Match_seasonId_fkey') THEN
        ALTER TABLE "Match" ADD CONSTRAINT "Match_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Match_mvpPlayerId_fkey') THEN
        ALTER TABLE "Match" ADD CONSTRAINT "Match_mvpPlayerId_fkey" FOREIGN KEY ("mvpPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Goal_matchId_fkey') THEN
        ALTER TABLE "Goal" ADD CONSTRAINT "Goal_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Goal_playerId_fkey') THEN
        ALTER TABLE "Goal" ADD CONSTRAINT "Goal_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchEvent_matchId_fkey') THEN
        ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchEvent_playerId_fkey') THEN
        ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchEvent_subPlayerId_fkey') THEN
        ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_subPlayerId_fkey" FOREIGN KEY ("subPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchEvent_assistPlayerId_fkey') THEN
        ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_assistPlayerId_fkey" FOREIGN KEY ("assistPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SeasonTeamPlayer_seasonId_fkey') THEN
        ALTER TABLE "SeasonTeamPlayer" ADD CONSTRAINT "SeasonTeamPlayer_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SeasonTeamPlayer_teamId_fkey') THEN
        ALTER TABLE "SeasonTeamPlayer" ADD CONSTRAINT "SeasonTeamPlayer_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SeasonTeamPlayer_playerId_fkey') THEN
        ALTER TABLE "SeasonTeamPlayer" ADD CONSTRAINT "SeasonTeamPlayer_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchLineup_matchId_fkey') THEN
        ALTER TABLE "MatchLineup" ADD CONSTRAINT "MatchLineup_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MatchLineup_playerId_fkey') THEN
        ALTER TABLE "MatchLineup" ADD CONSTRAINT "MatchLineup_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SeasonGroupTeam_seasonId_fkey') THEN
        ALTER TABLE "SeasonGroupTeam" ADD CONSTRAINT "SeasonGroupTeam_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SeasonGroupTeam_teamId_fkey') THEN
        ALTER TABLE "SeasonGroupTeam" ADD CONSTRAINT "SeasonGroupTeam_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
