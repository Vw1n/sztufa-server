-- SeasonTeamProfile was introduced after the 2026 seasons already existed.
-- Restore only those pre-existing seasons from the team master data. Seasons
-- created by later history imports remain isolated and keep their own snapshots.
WITH snapshot_schema AS (
  SELECT "finished_at" AT TIME ZONE 'UTC' AS "appliedAt"
  FROM "_prisma_migrations"
  WHERE "migration_name" = '20260728121500_add_season_team_profiles'
    AND "finished_at" IS NOT NULL
  LIMIT 1
)
UPDATE "SeasonTeamProfile" AS profile
SET
  "teamDoctor" = CASE
    WHEN NULLIF(BTRIM(COALESCE(profile."teamDoctor", '')), '') IS NULL
      THEN team."teamDoctor"
    ELSE profile."teamDoctor"
  END,
  "headCoach" = CASE
    WHEN NULLIF(BTRIM(COALESCE(profile."headCoach", '')), '') IS NULL
      THEN team."headCoach"
    ELSE profile."headCoach"
  END,
  "teamLeader" = CASE
    WHEN NULLIF(BTRIM(COALESCE(profile."teamLeader", '')), '') IS NULL
      THEN team."teamLeader"
    ELSE profile."teamLeader"
  END,
  "coachPhone" = CASE
    WHEN NULLIF(BTRIM(COALESCE(profile."coachPhone", '')), '') IS NULL
      THEN team."coachPhone"
    ELSE profile."coachPhone"
  END,
  "leaderPhone" = CASE
    WHEN NULLIF(BTRIM(COALESCE(profile."leaderPhone", '')), '') IS NULL
      THEN team."leaderPhone"
    ELSE profile."leaderPhone"
  END,
  "homeJerseyColor" = CASE
    WHEN BTRIM(COALESCE(profile."homeJerseyColor", '')) IN ('', '未记录', '???')
      THEN team."homeJerseyColor"
    ELSE profile."homeJerseyColor"
  END,
  "awayJerseyColor" = CASE
    WHEN BTRIM(COALESCE(profile."awayJerseyColor", '')) IN ('', '未记录', '???')
      THEN team."awayJerseyColor"
    ELSE profile."awayJerseyColor"
  END,
  "teamLogo" = COALESCE(profile."teamLogo", team."teamLogo"),
  "homeJersey" = COALESCE(profile."homeJersey", team."homeJersey"),
  "awayJersey" = COALESCE(profile."awayJersey", team."awayJersey"),
  "updatedAt" = CURRENT_TIMESTAMP
FROM "Team" AS team, "Season" AS season, snapshot_schema
WHERE profile."teamId" = team."id"
  AND profile."seasonId" = season."id"
  AND season."createdAt" < snapshot_schema."appliedAt";
