import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { MANDATORY_BACKUP_TABLES, TABLE_METADATA_MAP } from './backup-table-registry';
import { ParseStreamResult } from './backup-serializer';

export { MANDATORY_BACKUP_TABLES };

export interface BackupValidationResult {
  category: 'active' | 'legacy-archive' | 'quarantine';
  reason: string;
  data?: any;
}

export function classifyBackupContent(
  contentStr: string,
  byteSize: number,
  maxSizeBytes: number = 50 * 1024 * 1024,
): BackupValidationResult {
  if (byteSize > maxSizeBytes) {
    return {
      category: 'quarantine',
      reason: `文件体积 (${byteSize} bytes) 超过最大允许上限 (${maxSizeBytes} bytes)`,
    };
  }

  let data: any;
  try {
    data = JSON.parse(contentStr);
  } catch (err: any) {
    return { category: 'quarantine', reason: `JSON 语法解析失败: ${err?.message || '非法格式'}` };
  }

  if (!data || typeof data !== 'object' || !['2.0', '3.0'].includes(data.formatVersion)) {
    return { category: 'legacy-archive', reason: '旧版 1.0 / 非标准格式备份文件' };
  }

  try {
    validateBackupSchemaAndIntegrity(data);
    return { category: 'active', reason: `标准 V${data.formatVersion} 全量合规备份`, data };
  } catch (err: any) {
    const prefix = data.formatVersion === '3.0' ? 'V3 校验拦截' : 'V2 校验拦截';
    return { category: 'quarantine', reason: `${prefix}: ${err?.message || '架构校验未通过'}` };
  }
}

export function validateBackupStreamIntegrity(parseResult: ParseStreamResult): void {
  const allowedVersions = ['2.0', '3.0'];
  if (!parseResult.formatVersion || !allowedVersions.includes(parseResult.formatVersion)) {
    throw new BadRequestException(
      `不支持的备份文件格式版本: ${parseResult.formatVersion || '未定义'}，仅支持 2.0 及 3.0`,
    );
  }

  const manifest = parseResult.manifest;
  if (!manifest || typeof manifest !== 'object') {
    throw new BadRequestException('备份文件缺少 manifest 元数据信息');
  }

  if (manifest.checksumAlgorithm !== 'sha256' || !manifest.checksum) {
    throw new BadRequestException('备份文件元数据缺少合规的 sha256 校验和');
  }

  if (typeof manifest.checksum !== 'string' || !/^[a-fA-F0-9]{64}$/.test(manifest.checksum)) {
    throw new BadRequestException('备份文件元数据 SHA-256 校验和格式非法');
  }

  if (!manifest.tables || typeof manifest.tables !== 'object') {
    throw new BadRequestException('备份文件元数据缺少 tables 计数信息');
  }

  const manifestTableNames = Object.keys(manifest.tables);
  const actualTableNames = Object.keys(parseResult.tableCounts);

  for (const mandatoryTable of MANDATORY_BACKUP_TABLES) {
    if (!manifestTableNames.includes(mandatoryTable)) {
      throw new BadRequestException(`备份 Manifest 元数据缺少必要数据表计数: ${mandatoryTable}`);
    }
    if (!actualTableNames.includes(mandatoryTable)) {
      throw new BadRequestException(`备份数据体缺少必要数据表: ${mandatoryTable}`);
    }
  }

  if (actualTableNames.length !== MANDATORY_BACKUP_TABLES.length) {
    throw new BadRequestException(
      `备份数据体包含非预期的未知表，要求精确包含 ${MANDATORY_BACKUP_TABLES.length} 张表，实际获取 ${actualTableNames.length} 张`,
    );
  }

  for (const tableName of MANDATORY_BACKUP_TABLES) {
    const manifestCount = manifest.tables[tableName];
    const actualCount = parseResult.tableCounts[tableName];

    if (
      typeof manifestCount !== 'number' ||
      manifestCount < 0 ||
      !Number.isInteger(manifestCount)
    ) {
      throw new BadRequestException(`数据表 ${tableName} Manifest 计数必须是非负整数`);
    }

    if (actualCount !== manifestCount) {
      throw new BadRequestException(
        `数据表 ${tableName} 计数不匹配: Manifest 记录 ${manifestCount} 条，实际包含 ${actualCount} 条`,
      );
    }
  }

  // User 表至少 1 条约束仅作用于 full 全站灾备
  if (parseResult.scope === 'full') {
    if (!parseResult.tableCounts.User || parseResult.tableCounts.User === 0) {
      throw new BadRequestException('全站备份数据中 User 表为空，为防止系统管理员账号丢失拒绝还原');
    }
  }

  if (parseResult.computedChecksum.toLowerCase() !== manifest.checksum.toLowerCase()) {
    throw new BadRequestException(
      '备份数据摘要校验失败 (SHA-256 Mismatch)，数据可能已被篡改或损坏',
    );
  }

  // 基于 SQLite 磁盘索引校验外键引用约束
  for (const tableName of MANDATORY_BACKUP_TABLES) {
    const meta = TABLE_METADATA_MAP[tableName];
    if (!meta?.foreignKeys || meta.foreignKeys.length === 0) continue;

    // 可以在 NDJSON 中逐行检查 FK 引用
  }
}

/**
 * 校验外键关系的异步方法（基于 StagingStore 与 SQLite 索引）
 */
export async function validateForeignKeysFromStaging(
  parseResult: ParseStreamResult,
): Promise<void> {
  const staging = parseResult.stagingStore;

  for (const tableName of MANDATORY_BACKUP_TABLES) {
    const meta = TABLE_METADATA_MAP[tableName];
    if (!meta?.foreignKeys || meta.foreignKeys.length === 0) continue;

    for await (const batch of staging.iterateTable(tableName, 500)) {
      for (const row of batch) {
        for (const fk of meta.foreignKeys) {
          const val = row[fk.field];
          if (val !== undefined && val !== null) {
            const exists = staging.hasId(fk.targetTable, String(val));
            if (!exists) {
              throw new BadRequestException(
                `${tableName} 行 ${row.id || '未知'} 引用了不存在的 ${fk.targetTable} ID: ${val}`,
              );
            }
          }
        }
      }
    }
  }
}

/**
 * 兼容旧代码直接在内存 JSON 对象上的全量校验入口
 */
export function validateBackupSchemaAndIntegrity(data: any): void {
  if (!data || typeof data !== 'object') {
    throw new BadRequestException('备份文件内容为空或不是有效的 JSON 对象');
  }

  const allowedVersions = ['2.0', '3.0'];
  if (!data.formatVersion || !allowedVersions.includes(data.formatVersion)) {
    throw new BadRequestException(
      `不支持的备份文件格式版本: ${data.formatVersion || '未定义'}，仅支持 2.0 及 3.0`,
    );
  }

  if (data.formatVersion === '3.0') {
    const allowedV3Keys = new Set([
      'manifest',
      'formatVersion',
      'timestamp',
      'scope',
      'season',
      'tables',
    ]);
    const actualKeys = Object.keys(data);
    for (const k of actualKeys) {
      if (!allowedV3Keys.has(k)) {
        throw new BadRequestException(`V3 备份文件格式非法：包含非预期的顶层属性 "${k}"`);
      }
    }
  }

  if (!data.manifest || typeof data.manifest !== 'object') {
    throw new BadRequestException('备份文件缺少 manifest 元数据信息');
  }

  if (data.manifest.checksumAlgorithm !== 'sha256' || !data.manifest.checksum) {
    throw new BadRequestException('备份文件元数据缺少合规的 sha256 校验和');
  }

  if (
    typeof data.manifest.checksum !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(data.manifest.checksum)
  ) {
    throw new BadRequestException('备份文件元数据 SHA-256 校验和格式非法');
  }

  if (!data.manifest.tables || typeof data.manifest.tables !== 'object') {
    throw new BadRequestException('备份文件元数据缺少 tables 计数信息');
  }

  if (!data.tables || typeof data.tables !== 'object') {
    throw new BadRequestException('备份文件缺少 tables 数据体');
  }

  const manifestTableNames = Object.keys(data.manifest.tables);
  const dataTableNames = Object.keys(data.tables);

  for (const mandatoryTable of MANDATORY_BACKUP_TABLES) {
    if (!manifestTableNames.includes(mandatoryTable)) {
      throw new BadRequestException(`备份 Manifest 元数据缺少必要数据表计数: ${mandatoryTable}`);
    }
    if (!dataTableNames.includes(mandatoryTable)) {
      throw new BadRequestException(`备份数据体缺少必要数据表: ${mandatoryTable}`);
    }
  }

  if (dataTableNames.length !== MANDATORY_BACKUP_TABLES.length) {
    throw new BadRequestException(
      `备份数据体包含非预期的未知表，要求精确包含 ${MANDATORY_BACKUP_TABLES.length} 张表，实际获取 ${dataTableNames.length} 张`,
    );
  }

  for (const tableName of MANDATORY_BACKUP_TABLES) {
    const manifestCount = data.manifest.tables[tableName];
    const tableData = data.tables[tableName];

    if (!Array.isArray(tableData)) {
      throw new BadRequestException(`数据表 ${tableName} 数据不是有效的数组格式`);
    }

    if (
      typeof manifestCount !== 'number' ||
      manifestCount < 0 ||
      !Number.isInteger(manifestCount)
    ) {
      throw new BadRequestException(`数据表 ${tableName} Manifest 计数必须是非负整数`);
    }

    if (tableData.length !== manifestCount) {
      throw new BadRequestException(
        `数据表 ${tableName} 计数不匹配: Manifest 记录 ${manifestCount} 条，实际包含 ${tableData.length} 条`,
      );
    }
  }

  const scope = data.scope || data.manifest.scope || 'full';
  if (scope === 'full') {
    if (!data.tables.User || data.tables.User.length === 0) {
      throw new BadRequestException('备份数据中 User 表为空，为防止系统管理员账号丢失拒绝还原');
    }
  }

  const computedChecksum = crypto
    .createHash('sha256')
    .update(JSON.stringify(data.tables))
    .digest('hex');

  if (computedChecksum.toLowerCase() !== data.manifest.checksum.toLowerCase()) {
    throw new BadRequestException(
      '备份数据摘要校验失败 (SHA-256 Mismatch)，数据可能已被篡改或损坏',
    );
  }

  const isValidIsoDate = (val: any): boolean => {
    if (typeof val !== 'string') return false;
    const ts = Date.parse(val);
    return !isNaN(ts);
  };

  const validateDatesInRows = (rows: any[], tableName: string, dateFields: string[]) => {
    for (const row of rows) {
      for (const field of dateFields) {
        if (row[field] !== undefined && row[field] !== null) {
          if (!isValidIsoDate(row[field])) {
            throw new BadRequestException(
              `表 ${tableName} 字段 ${field} 包含无效日期值: ${row[field]}`,
            );
          }
        }
      }
    }
  };

  for (const [tableName, meta] of Object.entries(TABLE_METADATA_MAP)) {
    if (data.tables[tableName] && meta.dateFields.length) {
      validateDatesInRows(data.tables[tableName], tableName, meta.dateFields);
    }
  }

  const teamIds = new Set((data.tables.Team || []).map((t: any) => t.id));
  const seasonIds = new Set((data.tables.Season || []).map((s: any) => s.id));
  const memberIds = new Set((data.tables.MemberAccount || []).map((u: any) => u.id));
  const userIds = new Set((data.tables.User || []).map((u: any) => u.id));
  const matchIds = new Set((data.tables.Match || []).map((m: any) => m.id));
  const playerIds = new Set((data.tables.Player || []).map((p: any) => p.id));

  for (const u of data.tables.User || []) {
    if (u.teamId && !teamIds.has(u.teamId)) {
      throw new BadRequestException(`User 行 ${u.id} 引用了不存在的球队 ID: ${u.teamId}`);
    }
  }

  for (const p of data.tables.Player || []) {
    if (p.teamId && !teamIds.has(p.teamId)) {
      throw new BadRequestException(`Player 行 ${p.id} 引用了不存在的球队 ID: ${p.teamId}`);
    }
    if (p.suspendedAtMatchId && !matchIds.has(p.suspendedAtMatchId)) {
      throw new BadRequestException(
        `Player 行 ${p.id} 引用了不存在的停赛比赛 ID: ${p.suspendedAtMatchId}`,
      );
    }
  }

  for (const m of data.tables.Match || []) {
    if (m.homeTeamId && !teamIds.has(m.homeTeamId)) {
      throw new BadRequestException(`Match 行 ${m.id} 引用了不存在的主队 ID: ${m.homeTeamId}`);
    }
    if (m.awayTeamId && !teamIds.has(m.awayTeamId)) {
      throw new BadRequestException(`Match 行 ${m.id} 引用了不存在的客队 ID: ${m.awayTeamId}`);
    }
    if (m.seasonId && !seasonIds.has(m.seasonId)) {
      throw new BadRequestException(`Match 行 ${m.id} 引用了不存在的赛季 ID: ${m.seasonId}`);
    }
    if (m.mvpPlayerId && !playerIds.has(m.mvpPlayerId)) {
      throw new BadRequestException(
        `Match 行 ${m.id} 引用了不存在的 MVP 球员 ID: ${m.mvpPlayerId}`,
      );
    }
  }

  for (const pred of data.tables.Prediction || []) {
    if (pred.userId && !memberIds.has(pred.userId)) {
      throw new BadRequestException(
        `Prediction 行 ${pred.id} 引用了不存在的用户 ID: ${pred.userId}`,
      );
    }
    if (pred.matchId && !matchIds.has(pred.matchId)) {
      throw new BadRequestException(
        `Prediction 行 ${pred.id} 引用了不存在的比赛 ID: ${pred.matchId}`,
      );
    }
  }

  for (const g of data.tables.Goal || []) {
    if (g.matchId && !matchIds.has(g.matchId)) {
      throw new BadRequestException(`Goal 行 ${g.id} 引用了不存在的比赛 ID: ${g.matchId}`);
    }
    if (g.playerId && !playerIds.has(g.playerId)) {
      throw new BadRequestException(`Goal 行 ${g.id} 引用了不存在的球员 ID: ${g.playerId}`);
    }
  }

  for (const e of data.tables.MatchEvent || []) {
    if (e.matchId && !matchIds.has(e.matchId)) {
      throw new BadRequestException(`MatchEvent 行 ${e.id} 引用了不存在的比赛 ID: ${e.matchId}`);
    }
    if (e.playerId && !playerIds.has(e.playerId)) {
      throw new BadRequestException(`MatchEvent 行 ${e.id} 引用了不存在的球员 ID: ${e.playerId}`);
    }
    if (e.subPlayerId && !playerIds.has(e.subPlayerId)) {
      throw new BadRequestException(
        `MatchEvent 行 ${e.id} 引用了不存在的换下球员 ID: ${e.subPlayerId}`,
      );
    }
    if (e.assistPlayerId && !playerIds.has(e.assistPlayerId)) {
      throw new BadRequestException(
        `MatchEvent 行 ${e.id} 引用了不存在的助攻球员 ID: ${e.assistPlayerId}`,
      );
    }
  }

  for (const l of data.tables.MatchLineup || []) {
    if (l.matchId && !matchIds.has(l.matchId)) {
      throw new BadRequestException(`MatchLineup 引用了不存在的比赛 ID: ${l.matchId}`);
    }
    if (l.playerId && !playerIds.has(l.playerId)) {
      throw new BadRequestException(`MatchLineup 引用了不存在的球员 ID: ${l.playerId}`);
    }
  }

  for (const stp of data.tables.SeasonTeamProfile || []) {
    if (stp.seasonId && !seasonIds.has(stp.seasonId)) {
      throw new BadRequestException(`SeasonTeamProfile 引用了不存在的赛季 ID: ${stp.seasonId}`);
    }
    if (stp.teamId && !teamIds.has(stp.teamId)) {
      throw new BadRequestException(`SeasonTeamProfile 引用了不存在的球队 ID: ${stp.teamId}`);
    }
  }

  for (const stp of data.tables.SeasonTeamPlayer || []) {
    if (stp.seasonId && !seasonIds.has(stp.seasonId)) {
      throw new BadRequestException(`SeasonTeamPlayer 引用了不存在的赛季 ID: ${stp.seasonId}`);
    }
    if (stp.teamId && !teamIds.has(stp.teamId)) {
      throw new BadRequestException(`SeasonTeamPlayer 引用了不存在的球队 ID: ${stp.teamId}`);
    }
    if (stp.playerId && !playerIds.has(stp.playerId)) {
      throw new BadRequestException(`SeasonTeamPlayer 引用了不存在的球员 ID: ${stp.playerId}`);
    }
  }

  for (const sgt of data.tables.SeasonGroupTeam || []) {
    if (sgt.seasonId && !seasonIds.has(sgt.seasonId)) {
      throw new BadRequestException(`SeasonGroupTeam 引用了不存在的赛季 ID: ${sgt.seasonId}`);
    }
    if (sgt.teamId && !teamIds.has(sgt.teamId)) {
      throw new BadRequestException(`SeasonGroupTeam 引用了不存在的球队 ID: ${sgt.teamId}`);
    }
  }

  for (const sda of data.tables.SeasonDeletionApproval || []) {
    if (sda.seasonId && !seasonIds.has(sda.seasonId)) {
      throw new BadRequestException(
        `SeasonDeletionApproval 引用了不存在的赛季 ID: ${sda.seasonId}`,
      );
    }
    if (sda.approverId && !userIds.has(sda.approverId)) {
      throw new BadRequestException(
        `SeasonDeletionApproval 引用了不存在的审批人 ID: ${sda.approverId}`,
      );
    }
  }

  const validateCompositeUniqueness = (rows: any[], tableName: string, fields: string[]) => {
    const seen = new Set<string>();
    for (const row of rows) {
      const key = fields.map((f) => String(row[f])).join('::');
      if (seen.has(key)) {
        throw new BadRequestException(
          `表 ${tableName} 包含重复的复合唯一键 [${fields.join(', ')}]: ${key}`,
        );
      }
      seen.add(key);
    }
  };

  validateCompositeUniqueness(data.tables.Prediction || [], 'Prediction', ['userId', 'matchId']);
  validateCompositeUniqueness(data.tables.MatchLineup || [], 'MatchLineup', [
    'matchId',
    'playerId',
  ]);
  validateCompositeUniqueness(data.tables.SeasonTeamProfile || [], 'SeasonTeamProfile', [
    'seasonId',
    'teamId',
  ]);
  validateCompositeUniqueness(data.tables.SeasonTeamPlayer || [], 'SeasonTeamPlayer', [
    'seasonId',
    'playerId',
  ]);
  validateCompositeUniqueness(data.tables.SeasonGroupTeam || [], 'SeasonGroupTeam', [
    'seasonId',
    'teamId',
  ]);
  validateCompositeUniqueness(data.tables.SeasonDeletionApproval || [], 'SeasonDeletionApproval', [
    'seasonId',
    'approverId',
  ]);
}
