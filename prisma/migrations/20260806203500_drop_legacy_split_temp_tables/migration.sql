-- Prisma can apply multiple migrations on the same PostgreSQL session. Temporary
-- split tables created by 20260806190000 therefore still exist when the corrected
-- 20260806204000 migration starts. Drop only the current session's temp tables so
-- a clean database can apply the complete migration history in one deploy.
DROP TABLE IF EXISTS pg_temp."_SeasonPlayerSplit";
DROP TABLE IF EXISTS pg_temp."_SeasonTeamSplit";
