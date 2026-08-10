import { PrismaClient } from '@prisma/client';
import {
  getCanonicalWinnerTeamId,
  isHistoricalSeasonTeamIdMatch,
} from '../src/match/winner-team-id';

interface MatchAuditDetail {
  id: string;
  seasonName: string;
  homeTeamName: string;
  awayTeamName: string;
  score: string;
  oldWinnerTeamId: string | null;
  newWinnerTeamId: string | null;
  type: 'FIELD_CORRECTION' | 'FIELD_COMPLETION' | 'ALREADY_VALID' | 'CONFLICT_UNRESOLVABLE';
  reason?: string;
}

const getDesensitizedDbFingerprint = (dbUrl?: string): string => {
  if (!dbUrl) return 'UNKNOWN_DATABASE';
  try {
    const url = new URL(dbUrl);
    const host = url.hostname;
    const dbName = url.pathname.replace(/^\//, '');
    const desensitizedHost = host.length > 8 ? `${host.substring(0, 8)}****` : host;
    return `${desensitizedHost} / ${dbName}`;
  } catch {
    return 'POSTGRESQL_DATABASE';
  }
};

async function main() {
  const args = process.argv.slice(2);
  const isDryRunExplicit = args.includes('--dry-run');
  const isApplyExplicit = args.includes('--apply');

  if (isDryRunExplicit && isApplyExplicit) {
    console.error('[ERROR] --dry-run 和 --apply 为互斥参数，不能同时指定！');
    process.exit(1);
  }

  const isApply = isApplyExplicit;
  const modeName = isApply ? 'APPLY (写入数据库)' : 'DRY-RUN (只读审计)';

  const dbFingerprint = getDesensitizedDbFingerprint(process.env.DATABASE_URL);

  console.log('====================================================');
  console.log(` 🏆 Sztufa 比赛胜者 ID 数据修补工具`);
  console.log(` 运行模式: [ ${modeName} ]`);
  console.log(` 数据库目标指纹: ${dbFingerprint}`);
  console.log('====================================================\n');

  const prisma = new PrismaClient();

  try {
    // 候选记录查询：严格限定为 status = 'finished' 且 deletedAt IS NULL
    const candidates = await prisma.match.findMany({
      where: {
        status: 'finished',
        deletedAt: null,
      },
      include: {
        homeTeam: true,
        awayTeam: true,
        season: true,
        events: true,
      },
      orderBy: { matchDate: 'asc' },
    });

    const details: MatchAuditDetail[] = [];
    let countFieldCorrection = 0;
    let countFieldCompletion = 0;
    let countAlreadyValid = 0;
    let countConflictUnresolvable = 0;

    for (const match of candidates) {
      const canonicalWinner = getCanonicalWinnerTeamId({
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        homePenaltyScore: match.homePenaltyScore,
        awayPenaltyScore: match.awayPenaltyScore,
        winnerTeamId: match.winnerTeamId,
        events: match.events,
      });

      const oldWinner = match.winnerTeamId;
      const homeName = match.homeTeam?.teamName || match.homeTeamId;
      const awayName = match.awayTeam?.teamName || match.awayTeamId;
      const seasonName = match.season?.name || '未知赛季';
      const scoreStr = `${match.homeScore ?? 0}:${match.awayScore ?? 0}${
        match.homePenaltyScore !== null && match.awayPenaltyScore !== null
          ? ` (${match.homePenaltyScore}:${match.awayPenaltyScore})`
          : ''
      }`;

      if (!canonicalWinner) {
        countConflictUnresolvable++;
        details.push({
          id: match.id,
          seasonName,
          homeTeamName: homeName,
          awayTeamName: awayName,
          score: scoreStr,
          oldWinnerTeamId: oldWinner,
          newWinnerTeamId: null,
          type: 'CONFLICT_UNRESOLVABLE',
          reason: '比分/点球平局或数据矛盾，无法确定唯一胜者',
        });
        continue;
      }

      if (oldWinner === canonicalWinner) {
        countAlreadyValid++;
        details.push({
          id: match.id,
          seasonName,
          homeTeamName: homeName,
          awayTeamName: awayName,
          score: scoreStr,
          oldWinnerTeamId: oldWinner,
          newWinnerTeamId: canonicalWinner,
          type: 'ALREADY_VALID',
        });
      } else if (!oldWinner) {
        countFieldCompletion++;
        details.push({
          id: match.id,
          seasonName,
          homeTeamName: homeName,
          awayTeamName: awayName,
          score: scoreStr,
          oldWinnerTeamId: null,
          newWinnerTeamId: canonicalWinner,
          type: 'FIELD_COMPLETION',
          reason: '补齐缺失的 winnerTeamId',
        });
      } else {
        countFieldCorrection++;
        const isHistMatch = isHistoricalSeasonTeamIdMatch(oldWinner, canonicalWinner);
        details.push({
          id: match.id,
          seasonName,
          homeTeamName: homeName,
          awayTeamName: awayName,
          score: scoreStr,
          oldWinnerTeamId: oldWinner,
          newWinnerTeamId: canonicalWinner,
          type: 'FIELD_CORRECTION',
          reason: isHistMatch
            ? '修正无后缀基础 ID 为赛季规范 Team ID'
            : '纠偏与比赛结果冲突的错误 winnerTeamId',
        });
      }
    }

    console.log('---------------- 审计统计报告 (5维指标) ----------------');
    console.log(` 1. 候选比赛总数 (Candidates Total):   ${candidates.length}`);
    console.log(` 2. 错误字段纠偏 (Field Correction):   ${countFieldCorrection}`);
    console.log(` 3. 缺失字段补齐 (Field Completion):   ${countFieldCompletion}`);
    console.log(` 4. 无需修改 (Already Valid):         ${countAlreadyValid}`);
    console.log(` 5. 冲突/无法推导 (Conflict/Unresolvable): ${countConflictUnresolvable}`);
    console.log('--------------------------------------------------------\n');

    const pendingModifications = details.filter(
      (d) => d.type === 'FIELD_CORRECTION' || d.type === 'FIELD_COMPLETION',
    );

    if (pendingModifications.length > 0) {
      console.log(`📋 待修补比赛明细列表 (共 ${pendingModifications.length} 场):`);
      pendingModifications.forEach((d, idx) => {
        console.log(
          `  [${idx + 1}] ID: ${d.id} | 赛季: ${d.seasonName} | 对阵: ${d.homeTeamName} VS ${d.awayTeamName} (${d.score})`,
        );
        console.log(
          `      类型: ${d.type} | 原 winnerTeamId: ${d.oldWinnerTeamId} -> 新 winnerTeamId: ${d.newWinnerTeamId}`,
        );
        if (d.reason) console.log(`      原因: ${d.reason}`);
      });
      console.log('');
    } else {
      console.log(
        '✨ 提示：没有发现需要修补的比赛记录，所有 finished 比赛的 winnerTeamId 均合规！\n',
      );
    }

    if (!isApply) {
      console.log('----------------------------------------------------');
      console.log(' 💡 当前为 DRY-RUN 只读模式，未写库。');
      console.log(' 💡 如需正式应用修补，请运行: npm run winner-ids:apply');
      console.log('----------------------------------------------------');
    } else {
      if (pendingModifications.length === 0) {
        console.log('无需写入，已退出。');
        return;
      }

      console.log('🚀 开始在事务中以 CAS 锁机制执行修补写入...');

      await prisma.$transaction(
        async (tx) => {
          for (const item of pendingModifications) {
            const res = await tx.match.updateMany({
              where: {
                id: item.id,
                winnerTeamId: item.oldWinnerTeamId,
              },
              data: {
                winnerTeamId: item.newWinnerTeamId,
              },
            });

            if (res.count !== 1) {
              throw new Error(
                `[CAS FAILURE] 比赛 ${item.id} 更新受影响行数期望 1，实际得 ${res.count}！触发事务全量回滚！`,
              );
            }
          }
        },
        { timeout: 30000 },
      );

      console.log('🎉 数据库修补事务提交成功！全量变更已生效。');
    }
  } catch (error) {
    console.error('\n❌ 脚本运行出错:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
