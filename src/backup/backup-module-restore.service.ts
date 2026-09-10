import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BackupObjectStoreService } from './backup-object-store.service';
import { BackupVerificationService } from './backup-verification.service';
import { BackupExportService } from './backup-export.service';
import { BackupManifestV4, ParseStreamResult } from './backup-format';
import { BACKUP_MODULE_REGISTRY, BACKUP_MODULES, BackupModule } from './backup-module-registry';
import { getSeasonModuleWhereClause } from './backup-plan.service';
import { PersistentBackupTableName, TABLE_METADATA_MAP } from './backup-table-registry';

const SEASON_INSERT_ORDER: PersistentBackupTableName[] = [
  'Team',
  'Player',
  'Season',
  'SeasonTeamProfile',
  'SeasonGroupTeam',
  'SeasonTeamPlayer',
  'Match',
  'MatchLineup',
  'Goal',
  'MatchEvent',
  'SeasonDeletionApproval',
  'TeamRegistration',
  'RegistrationTeamData',
  'RegistrationPlayer',
  'Prediction',
];

interface RestoreTokenPayload {
  key: string;
  fileSha256: string;
  username: string;
  expiresAt: number;
}

@Injectable()
export class BackupModuleRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly objectStore: BackupObjectStoreService,
    private readonly verificationService: BackupVerificationService,
    private readonly exportService: BackupExportService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async preview(username: string, key: string) {
    const parsed = await this.parse(key);
    try {
      const manifest = this.requireModuleManifest(parsed);
      const module = manifest.module as BackupModule;
      const expiresAt = Date.now() + 10 * 60 * 1000;
      const canExecute = this.isRestoreEnabled(module);
      return {
        key,
        module,
        selector: manifest.selector,
        strategy: BACKUP_MODULE_REGISTRY[module].restoreStrategy,
        tableCounts: parsed.tableCounts,
        compressedBytes: parsed.compressedSize,
        decompressedBytes: parsed.decompressedSize,
        canExecute,
        warning:
          module === 'season'
            ? '将替换目标赛季数据；共享球队和球员仅补充缺失记录，不删除其他赛季数据。'
            : '按 ID 合并模块数据，不删除备份中不存在的现有记录。',
        expiresAt: new Date(expiresAt).toISOString(),
        restoreToken: this.signToken({ key, fileSha256: parsed.fileSha256, username, expiresAt }),
      };
    } finally {
      parsed.cleanup();
    }
  }

  async execute(username: string, key: string, restoreToken: string, confirmText?: string) {
    if (confirmText !== 'CONFIRM_MODULE_RESTORE') {
      throw new BadRequestException('模块恢复确认文本必须为 "CONFIRM_MODULE_RESTORE"');
    }
    const token = this.verifyToken(restoreToken);
    if (token.key !== key || token.username !== username) {
      throw new BadRequestException('恢复 Preview 令牌与当前请求不匹配');
    }

    const parsed = await this.parse(key);
    try {
      if (parsed.fileSha256 !== token.fileSha256) {
        throw new BadRequestException('备份文件在 Preview 后发生变化，必须重新预检');
      }
      const manifest = this.requireModuleManifest(parsed);
      const module = manifest.module as BackupModule;
      if (!this.isRestoreEnabled(module)) {
        throw new ServiceUnavailableException(`${module} 模块恢复功能未启用`);
      }

      const snapshot = await this.exportService.createBackup(username, {
        scope: 'module',
        module,
        selector: manifest.selector,
        purpose: 'pre-restore',
        protected: true,
      });

      await this.prisma.$transaction(
        async (tx) => {
          const [{ locked }] = await tx.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(88998899) AS locked`;
          if (!locked) throw new ConflictException('已有其他进程或节点正在执行数据库恢复操作');

          if (module === 'season') {
            await this.restoreSeason(tx, parsed, manifest.selector.seasonId);
          } else {
            await this.mergeModule(tx, parsed, module);
          }
          if (module === 'staff') {
            const superAdminCount = await tx.user.count({ where: { role: 'super_admin' } });
            if (superAdminCount < 1) {
              throw new BadRequestException('管理员模块恢复后必须至少保留一个超级管理员');
            }
          }
        },
        {
          maxWait: 20000,
          timeout: parseInt(process.env.BACKUP_RESTORE_TX_TIMEOUT_MS || '300000', 10),
        },
      );

      await this.auditLogService.log(
        username,
        'RESTORE_MODULE_BACKUP',
        `从 ${key} 恢复 ${module} 模块，恢复前保护备份: ${snapshot.key}。`,
      );
      return `${module} 模块恢复成功`;
    } finally {
      parsed.cleanup();
    }
  }

  private async parse(key: string): Promise<ParseStreamResult> {
    this.objectStore.validateBackupKey(key);
    return this.verificationService.parseAndValidate(await this.objectStore.getObjectBody(key));
  }

  private requireModuleManifest(parsed: ParseStreamResult): BackupManifestV4 {
    const manifest = parsed.manifest as BackupManifestV4 | undefined;
    if (
      parsed.formatVersion !== '4.0' ||
      parsed.scope !== 'module' ||
      !manifest ||
      manifest.module === 'full' ||
      !BACKUP_MODULES.includes(manifest.module as BackupModule)
    ) {
      throw new BadRequestException('仅支持对已验证的 V4 模块备份执行 Preview 或模块恢复');
    }
    return manifest;
  }

  private isRestoreEnabled(module: BackupModule): boolean {
    return (
      process.env.BACKUP_RESTORE_ENABLED === 'true' &&
      process.env[`BACKUP_RESTORE_${module.toUpperCase()}_ENABLED`] === 'true'
    );
  }

  private getTokenSecret(): string {
    const secret = process.env.BACKUP_RESTORE_TOKEN_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new ServiceUnavailableException('恢复令牌签名密钥未配置');
    return secret;
  }

  private signToken(payload: RestoreTokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.getTokenSecret())
      .update(encoded)
      .digest('base64url');
    return `${encoded}.${signature}`;
  }

  private verifyToken(token: string): RestoreTokenPayload {
    const [encoded, signature] = token?.split('.') || [];
    if (!encoded || !signature) throw new BadRequestException('恢复 Preview 令牌格式错误');
    const expected = crypto.createHmac('sha256', this.getTokenSecret()).update(encoded).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      throw new BadRequestException('恢复 Preview 令牌格式错误');
    }
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new BadRequestException('恢复 Preview 令牌签名无效');
    }
    let payload: RestoreTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as RestoreTokenPayload;
    } catch {
      throw new BadRequestException('恢复 Preview 令牌载荷无效');
    }
    if (payload.expiresAt <= Date.now()) throw new BadRequestException('恢复 Preview 令牌已过期');
    return payload;
  }

  private formatRow(table: PersistentBackupTableName, row: any): any {
    const cleaned = { ...row };
    for (const field of TABLE_METADATA_MAP[table].dateFields) {
      if (cleaned[field] !== undefined && cleaned[field] !== null) {
        cleaned[field] = new Date(cleaned[field]);
      }
    }
    if (table === 'User' || table === 'MemberAccount') {
      cleaned.sessionVersion = Math.floor(Date.now() / 1000);
    }
    if (table === 'MemberAccount' && cleaned.verificationStatus === 'PENDING') {
      cleaned.verificationStatus = 'CHANGES_REQUESTED';
      cleaned.reviewComment = '系统恢复后请重新提交校园卡';
    }
    return cleaned;
  }

  private async mergeModule(tx: any, parsed: ParseStreamResult, module: BackupModule) {
    for (const table of BACKUP_MODULE_REGISTRY[module].ownedTables) {
      const delegate = tx[TABLE_METADATA_MAP[table].prismaDelegateName];
      for await (const batch of parsed.stagingStore.iterateTable(table, 500)) {
        for (const source of batch) {
          const row = this.formatRow(table, source);
          const update = { ...row };
          delete update.id;
          if (table === 'User') {
            row.teamId = null;
            delete update.teamId;
          }
          await delegate.upsert({ where: { id: row.id }, create: row, update });
        }
      }
    }
  }

  private async restoreSeason(tx: any, parsed: ParseStreamResult, seasonId?: string) {
    if (!seasonId) throw new BadRequestException('赛季模块恢复缺少 seasonId');

    await tx.player.updateMany({
      where: { suspendedAtMatch: { seasonId } },
      data: { suspendedAtMatchId: null },
    });
    const deleteOrder: PersistentBackupTableName[] = [
      'RegistrationPlayer',
      'RegistrationTeamData',
      'TeamRegistration',
      'MatchLineup',
      'Goal',
      'MatchEvent',
      'Prediction',
      'SeasonTeamPlayer',
      'SeasonTeamProfile',
      'SeasonGroupTeam',
      'SeasonDeletionApproval',
      'Match',
      'Season',
    ];
    for (const table of deleteOrder) {
      const delegate = tx[TABLE_METADATA_MAP[table].prismaDelegateName];
      await delegate.deleteMany({ where: getSeasonModuleWhereClause(table, seasonId) });
    }

    for (const table of SEASON_INSERT_ORDER) {
      const delegate = tx[TABLE_METADATA_MAP[table].prismaDelegateName];
      for await (const batch of parsed.stagingStore.iterateTable(table, 500)) {
        const rows = batch.map((source) => {
          const row = this.formatRow(table, source);
          if (table === 'Match') row.mvpPlayerId = null;
          if (table === 'Player') row.suspendedAtMatchId = null;
          return row;
        });
        if (!rows.length) continue;
        if (table === 'Team' || table === 'Player') {
          await delegate.createMany({ data: rows, skipDuplicates: true });
        } else {
          await delegate.createMany({ data: rows });
        }
      }
    }

    for await (const batch of parsed.stagingStore.iterateTable('Match', 500)) {
      for (const match of batch) {
        if (match.mvpPlayerId) {
          await tx.match.update({
            where: { id: match.id },
            data: { mvpPlayerId: match.mvpPlayerId },
          });
        }
      }
    }
    for await (const batch of parsed.stagingStore.iterateTable('Player', 500)) {
      for (const player of batch) {
        if (player.suspendedAtMatchId) {
          await tx.player.update({
            where: { id: player.id },
            data: { suspendedAtMatchId: player.suspendedAtMatchId },
          });
        }
      }
    }

    const restoredSeason = await tx.season.findUnique({
      where: { id: seasonId },
      select: { id: true },
    });
    if (!restoredSeason) throw new BadRequestException('赛季备份未恢复目标 Season 记录');
  }
}
