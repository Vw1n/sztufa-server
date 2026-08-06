-- Database guardrail: a team identity can belong to exactly one season.
-- Same-name teams in different seasons must use different Team rows.
CREATE UNIQUE INDEX "SeasonTeamProfile_teamId_one_season_key"
ON "SeasonTeamProfile"("teamId");
