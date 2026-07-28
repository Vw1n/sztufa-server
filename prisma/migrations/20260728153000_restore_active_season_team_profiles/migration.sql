-- 恢复活跃赛季中被历史导入空白快照遮住的球队资料。
-- 只填充空值或占位值，避免覆盖已经独立维护的赛季资料。
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
FROM "Team" AS team, "Season" AS season
WHERE profile."teamId" = team."id"
  AND profile."seasonId" = season."id"
  AND season."status" = 'active';
