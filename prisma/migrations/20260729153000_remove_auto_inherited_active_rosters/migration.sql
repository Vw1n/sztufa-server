-- Older season creation code registered every existing player in the new season.
-- Those generated rows share the exact transaction timestamp with the season.
-- Remove only such rows from currently active seasons. Registrations performed
-- later by team entry/import run in another transaction and are preserved.
DELETE FROM "SeasonTeamPlayer" AS roster
USING "Season" AS season
WHERE roster."seasonId" = season."id"
  AND season."status" = 'active'
  AND roster."createdAt" = season."createdAt";
