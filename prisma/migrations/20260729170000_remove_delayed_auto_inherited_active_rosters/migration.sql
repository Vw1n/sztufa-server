-- In production-compatible databases, defaults used by the season insert and
-- the following roster createMany statement can differ by a fraction of a
-- second. The earlier exact-timestamp cleanup therefore missed those rows.
--
-- Automatic inheritance runs immediately after season creation. Preserve teams
-- that have since gained explicit season evidence through a group or a match,
-- and remove only roster rows created in the first five seconds otherwise.
DELETE FROM "SeasonTeamPlayer" AS roster
USING "Season" AS season
WHERE roster."seasonId" = season."id"
  AND season."status" = 'active'
  AND roster."createdAt" >= season."createdAt"
  AND roster."createdAt" <= season."createdAt" + INTERVAL '5 seconds'
  AND NOT EXISTS (
    SELECT 1
    FROM "SeasonGroupTeam" AS group_team
    WHERE group_team."seasonId" = season."id"
      AND group_team."teamId" = roster."teamId"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "Match" AS match
    WHERE match."seasonId" = season."id"
      AND (
        match."homeTeamId" = roster."teamId"
        OR match."awayTeamId" = roster."teamId"
      )
  );
