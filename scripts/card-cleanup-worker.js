// 由部署方进程管理器运行；Serverless 请由可靠调度器调用同一内部端点。
require('dotenv').config();
const endpoint = process.env.CARD_CLEANUP_ENDPOINT;
const secret = process.env.CRON_SECRET;
if (!endpoint || !secret || !/^https:\/\//.test(endpoint)) {
  throw new Error('请配置 HTTPS CARD_CLEANUP_ENDPOINT 和 CRON_SECRET');
}
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function run() {
  while (!stopping) {
    try {
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(240_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      console.log(`校园卡清理：尝试 ${result.attempted}，完成 ${result.deleted}`);
    } catch { console.error('校园卡清理调用失败，将自动重试；请检查服务与调度告警'); }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 30_000));
  }
}
run().catch(() => { process.exitCode = 1; });
