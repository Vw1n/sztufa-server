-- 2026 校长杯男子组的四院联队仅保留已确认的球员名单与视觉资料。
-- 清空误录的领队、主教练、队医及主客场颜色，不影响其他赛季或球队。
UPDATE "Team"
SET
  "teamLeader" = NULL,
  "headCoach" = NULL,
  "teamDoctor" = NULL,
  "homeJerseyColor" = '',
  "awayJerseyColor" = ''
WHERE "id" = 'cmrubcvla0020buk2mf5qrblh'
  AND "teamName" = '四院联队';

UPDATE "SeasonTeamProfile"
SET
  "teamLeader" = NULL,
  "headCoach" = NULL,
  "teamDoctor" = NULL,
  "homeJerseyColor" = '',
  "awayJerseyColor" = ''
WHERE "seasonId" = 'cmroeexdz00018js1kmbmyog5'
  AND "teamId" = 'cmrubcvla0020buk2mf5qrblh'
  AND "teamName" = '四院联队';
