-- Restore season-specific team profiles only when historical participation is
-- proven by a roster, group assignment, or match. Soft-deleted teams remain
-- deleted and are deliberately excluded from recovery.
WITH evidenced_teams AS (
  SELECT "seasonId", "teamId" FROM "SeasonTeamPlayer"
  UNION
  SELECT "seasonId", "teamId" FROM "SeasonGroupTeam"
  UNION
  SELECT "seasonId", "homeTeamId" AS "teamId" FROM "Match"
  UNION
  SELECT "seasonId", "awayTeamId" AS "teamId" FROM "Match"
), live_evidenced_teams AS (
  SELECT evidence."seasonId", evidence."teamId"
  FROM evidenced_teams evidence
  JOIN "Team" team ON team."id" = evidence."teamId"
  WHERE evidence."teamId" IS NOT NULL
    AND team."deletedAt" IS NULL
)
INSERT INTO "SeasonTeamProfile" (
  "id", "seasonId", "teamId", "teamName", "teamDoctor", "headCoach",
  "teamLeader", "coachPhone", "leaderPhone", "homeJerseyColor",
  "awayJerseyColor", "teamLogo", "homeJersey", "awayJersey", "gender",
  "isRegistered", "createdAt", "updatedAt"
)
SELECT
  'restored_' || MD5(evidence."seasonId" || ':' || evidence."teamId"),
  evidence."seasonId", evidence."teamId", team."teamName", team."teamDoctor",
  team."headCoach", team."teamLeader", team."coachPhone", team."leaderPhone",
  team."homeJerseyColor", team."awayJerseyColor", team."teamLogo",
  team."homeJersey", team."awayJersey", team."gender", TRUE,
  team."createdAt", CURRENT_TIMESTAMP
FROM live_evidenced_teams evidence
JOIN "Team" team ON team."id" = evidence."teamId"
ON CONFLICT ("seasonId", "teamId") DO UPDATE
SET "isRegistered" = TRUE,
    "updatedAt" = CURRENT_TIMESTAMP;
