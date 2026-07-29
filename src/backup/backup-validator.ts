import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';

export const MANDATORY_BACKUP_TABLES = [
  'User',
  'Team',
  'Player',
  'Season',
  'Match',
  'Prediction',
  'Goal',
  'MatchEvent',
  'News',
  'AuditLog',
  'SeasonTeamProfile',
  'HistoryImportBatch',
  'SeasonDeletionApproval',
  'SeasonTeamPlayer',
  'MatchLineup',
  'SeasonGroupTeam',
  'PdfImportBatch',
] as const;

export interface BackupValidationResult {
  category: 'active' | 'legacy-archive' | 'quarantine';
  reason: string;
  data?: any;
}

export function validateBackupSchemaAndIntegrity(data: any): void {
  if (!data || typeof data !== 'object') {
    throw new BadRequestException('备份文件内容为空或不是有效的 JSON 对象');
  }

  if (data.formatVersion !== '2.0') {
    throw new BadRequestException(
      `不支持的备份文件格式版本: ${data.formatVersion || '未定义'}，仅支持 2.0`,
    );
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

  if (!data.tables.User || data.tables.User.length === 0) {
    throw new BadRequestException('备份数据中 User 表为空，为防止系统管理员账号丢失拒绝还原');
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

  validateDatesInRows(data.tables.Match, 'Match', [
    'matchDate',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ]);
  validateDatesInRows(data.tables.News, 'News', [
    'publishedAt',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ]);
  validateDatesInRows(data.tables.AuditLog, 'AuditLog', ['createdAt']);
  validateDatesInRows(data.tables.HistoryImportBatch, 'HistoryImportBatch', [
    'createdAt',
    'undoneAt',
  ]);

  const teamIds = new Set((data.tables.Team || []).map((t: any) => t.id));
  const seasonIds = new Set((data.tables.Season || []).map((s: any) => s.id));
  const userIds = new Set((data.tables.User || []).map((u: any) => u.id));
  const matchIds = new Set((data.tables.Match || []).map((m: any) => m.id));

  for (const p of data.tables.Player || []) {
    if (p.teamId && !teamIds.has(p.teamId)) {
      throw new BadRequestException(`Player 行 ${p.id} 引用了不存在的球队 ID: ${p.teamId}`);
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
  }

  for (const pred of data.tables.Prediction || []) {
    if (pred.userId && !userIds.has(pred.userId)) {
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

  if (!data || typeof data !== 'object' || data.formatVersion !== '2.0') {
    return { category: 'legacy-archive', reason: '旧版 1.0 / 非 V2 格式备份文件' };
  }

  try {
    validateBackupSchemaAndIntegrity(data);
    return { category: 'active', reason: '标准 V2.0 全量合规备份', data };
  } catch (err: any) {
    return { category: 'quarantine', reason: `V2 校验拦截: ${err?.message || '架构校验未通过'}` };
  }
}
