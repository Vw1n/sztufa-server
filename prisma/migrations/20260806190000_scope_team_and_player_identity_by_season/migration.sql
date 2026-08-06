-- Team names and player student IDs are season-scoped through
-- SeasonTeamProfile and SeasonTeamPlayer. Keeping these master-table indexes
-- unique causes records from different seasons to be merged and overwritten.
DROP INDEX IF EXISTS "Team_teamName_key";
DROP INDEX IF EXISTS "Player_studentId_key";

CREATE INDEX IF NOT EXISTS "Player_studentId_idx" ON "Player"("studentId");

-- Split legacy team identities that were shared by more than one season.
CREATE TEMP TABLE "_SeasonTeamSplit" AS
SELECT
  profile."seasonId",
  profile."teamId" AS "oldTeamId",
  profile."teamId" || '_season_' || SUBSTRING(MD5(profile."seasonId"), 1, 12) AS "newTeamId"
FROM (
  SELECT
    profile.*,
    ROW_NUMBER() OVER (PARTITION BY profile."teamId" ORDER BY season."createdAt", profile."createdAt") AS position
  FROM "SeasonTeamProfile" profile
  JOIN "Season" season ON season."id" = profile."seasonId"
) profile
WHERE profile.position > 1;

INSERT INTO "Team" (
  "id", "teamName", "teamDoctor", "headCoach", "teamLeader", "coachPhone",
  "leaderPhone", "homeJerseyColor", "awayJerseyColor", "teamLogo", "homeJersey",
  "awayJersey", "gender", "deletedAt", "createdAt", "updatedAt"
)
SELECT
  split."newTeamId", profile."teamName", profile."teamDoctor", profile."headCoach",
  profile."teamLeader", profile."coachPhone", profile."leaderPhone",
  profile."homeJerseyColor", profile."awayJerseyColor", profile."teamLogo",
  profile."homeJersey", profile."awayJersey", profile."gender", NULL,
  profile."createdAt", profile."updatedAt"
FROM "_SeasonTeamSplit" split
JOIN "SeasonTeamProfile" profile
  ON profile."seasonId" = split."seasonId" AND profile."teamId" = split."oldTeamId"
ON CONFLICT ("id") DO NOTHING;

UPDATE "SeasonTeamProfile" profile
SET "teamId" = split."newTeamId"
FROM "_SeasonTeamSplit" split
WHERE profile."seasonId" = split."seasonId" AND profile."teamId" = split."oldTeamId";

UPDATE "SeasonTeamPlayer" roster
SET "teamId" = split."newTeamId"
FROM "_SeasonTeamSplit" split
WHERE roster."seasonId" = split."seasonId" AND roster."teamId" = split."oldTeamId";

UPDATE "SeasonGroupTeam" grouped
SET "teamId" = split."newTeamId"
FROM "_SeasonTeamSplit" split
WHERE grouped."seasonId" = split."seasonId" AND grouped."teamId" = split."oldTeamId";

UPDATE "Match" match
SET "homeTeamId" = split."newTeamId"
FROM "_SeasonTeamSplit" split
WHERE match."seasonId" = split."seasonId" AND match."homeTeamId" = split."oldTeamId";

UPDATE "Match" match
SET "awayTeamId" = split."newTeamId"
FROM "_SeasonTeamSplit" split
WHERE match."seasonId" = split."seasonId" AND match."awayTeamId" = split."oldTeamId";

CREATE TEMP TABLE "_SeasonPlayerSplit" AS
SELECT
  roster."seasonId",
  roster."playerId" AS "oldPlayerId",
  roster."teamId" AS "newTeamId",
  roster."playerId" || '_season_' || SUBSTRING(MD5(roster."seasonId"), 1, 12) AS "newPlayerId"
FROM "SeasonTeamPlayer" roster
JOIN "_SeasonTeamSplit" split
  ON split."seasonId" = roster."seasonId" AND split."newTeamId" = roster."teamId";

INSERT INTO "Player" (
  "id", "name", "studentId", "legacyKey", "jerseyNumber", "photo", "status",
  "yellowCards", "redCards", "suspendedAtMatchId", "teamId", "deletedAt",
  "createdAt", "updatedAt"
)
SELECT
  split."newPlayerId", roster."playerName", player."studentId", NULL,
  roster."jerseyNumber", roster."playerPhoto", player."status", player."yellowCards",
  player."redCards", NULL, split."newTeamId", NULL, player."createdAt", player."updatedAt"
FROM "_SeasonPlayerSplit" split
JOIN "Player" player ON player."id" = split."oldPlayerId"
JOIN "SeasonTeamPlayer" roster
  ON roster."seasonId" = split."seasonId" AND roster."playerId" = split."oldPlayerId"
ON CONFLICT ("id") DO NOTHING;

UPDATE "Goal" goal
SET "playerId" = split."newPlayerId"
FROM "_SeasonPlayerSplit" split, "Match" match
WHERE goal."matchId" = match."id" AND match."seasonId" = split."seasonId"
  AND goal."playerId" = split."oldPlayerId";

UPDATE "MatchEvent" event
SET "playerId" = split."newPlayerId"
FROM "_SeasonPlayerSplit" split, "Match" match
WHERE event."matchId" = match."id" AND match."seasonId" = split."seasonId"
  AND event."playerId" = split."oldPlayerId";

UPDATE "MatchEvent" event
SET "subPlayerId" = split."newPlayerId"
FROM "_SeasonPlayerSplit" split, "Match" match
WHERE event."matchId" = match."id" AND match."seasonId" = split."seasonId"
  AND event."subPlayerId" = split."oldPlayerId";

UPDATE "MatchEvent" event
SET "assistPlayerId" = split."newPlayerId"
FROM "_SeasonPlayerSplit" split, "Match" match
WHERE event."matchId" = match."id" AND match."seasonId" = split."seasonId"
  AND event."assistPlayerId" = split."oldPlayerId";

UPDATE "MatchLineup" lineup
SET "playerId" = split."newPlayerId"
FROM "_SeasonPlayerSplit" split, "Match" match
WHERE lineup."matchId" = match."id" AND match."seasonId" = split."seasonId"
  AND lineup."playerId" = split."oldPlayerId";

UPDATE "Match" match
SET "mvpPlayerId" = split."newPlayerId"
FROM "_SeasonPlayerSplit" split
WHERE match."seasonId" = split."seasonId" AND match."mvpPlayerId" = split."oldPlayerId";

UPDATE "SeasonTeamPlayer" roster
SET "playerId" = split."newPlayerId"
FROM "_SeasonPlayerSplit" split
WHERE roster."seasonId" = split."seasonId" AND roster."playerId" = split."oldPlayerId";
