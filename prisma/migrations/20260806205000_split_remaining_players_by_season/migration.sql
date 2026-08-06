-- Finish season isolation for players who legitimately appeared in multiple
-- seasons or changed teams between seasons. Keep the oldest season's ID and
-- clone every later season from its immutable roster snapshot.
CREATE TEMP TABLE "_RemainingPlayerSplit" AS
SELECT
  roster."seasonId", roster."teamId", roster."playerId" AS "oldPlayerId",
  roster."playerId" || '_season_' || SUBSTRING(MD5(roster."seasonId"), 1, 12) AS "newPlayerId"
FROM (
  SELECT roster.*,
    ROW_NUMBER() OVER (
      PARTITION BY roster."playerId"
      ORDER BY season."createdAt", roster."createdAt", roster."seasonId"
    ) AS position
  FROM "SeasonTeamPlayer" roster
  JOIN "Season" season ON season."id" = roster."seasonId"
) roster
WHERE roster.position > 1;

INSERT INTO "Player" (
  "id", "name", "studentId", "legacyKey", "jerseyNumber", "photo", "status",
  "yellowCards", "redCards", "suspendedAtMatchId", "teamId", "deletedAt",
  "createdAt", "updatedAt"
)
SELECT
  split."newPlayerId", roster."playerName", roster."studentId", NULL,
  roster."jerseyNumber", roster."playerPhoto", player."status", player."yellowCards",
  player."redCards", NULL, split."teamId", NULL, player."createdAt", player."updatedAt"
FROM "_RemainingPlayerSplit" split
JOIN "Player" player ON player."id" = split."oldPlayerId"
JOIN "SeasonTeamPlayer" roster
  ON roster."seasonId" = split."seasonId" AND roster."playerId" = split."oldPlayerId"
ON CONFLICT ("id") DO NOTHING;

UPDATE "Goal" goal SET "playerId" = split."newPlayerId"
FROM "_RemainingPlayerSplit" split, "Match" match
WHERE goal."matchId" = match."id" AND match."seasonId" = split."seasonId"
  AND goal."playerId" = split."oldPlayerId";

UPDATE "MatchEvent" event SET "playerId" = split."newPlayerId"
FROM "_RemainingPlayerSplit" split, "Match" match
WHERE event."matchId" = match."id" AND match."seasonId" = split."seasonId"
  AND event."playerId" = split."oldPlayerId";

UPDATE "MatchEvent" event SET "subPlayerId" = split."newPlayerId"
FROM "_RemainingPlayerSplit" split, "Match" match
WHERE event."matchId" = match."id" AND match."seasonId" = split."seasonId"
  AND event."subPlayerId" = split."oldPlayerId";

UPDATE "MatchEvent" event SET "assistPlayerId" = split."newPlayerId"
FROM "_RemainingPlayerSplit" split, "Match" match
WHERE event."matchId" = match."id" AND match."seasonId" = split."seasonId"
  AND event."assistPlayerId" = split."oldPlayerId";

UPDATE "MatchLineup" lineup SET "playerId" = split."newPlayerId"
FROM "_RemainingPlayerSplit" split, "Match" match
WHERE lineup."matchId" = match."id" AND match."seasonId" = split."seasonId"
  AND lineup."playerId" = split."oldPlayerId";

UPDATE "Match" match SET "mvpPlayerId" = split."newPlayerId"
FROM "_RemainingPlayerSplit" split
WHERE match."seasonId" = split."seasonId" AND match."mvpPlayerId" = split."oldPlayerId";

UPDATE "SeasonTeamPlayer" roster SET "playerId" = split."newPlayerId"
FROM "_RemainingPlayerSplit" split
WHERE roster."seasonId" = split."seasonId" AND roster."playerId" = split."oldPlayerId";
