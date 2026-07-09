import { Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class BackupService {
  private s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createBackup(username: string): Promise<string> {
    // 1. 获取所有表的数据
    const backupData = {
      version: '1.0',
      timestamp: Date.now(),
      teams: await this.prisma.team.findMany(),
      players: await this.prisma.player.findMany(),
      matches: await this.prisma.match.findMany(),
      goals: await this.prisma.goal.findMany(),
      matchEvents: await this.prisma.matchEvent.findMany(),
      news: await this.prisma.news.findMany(),
      auditLogs: await this.prisma.auditLog.findMany(),
    };

    const serializedData = JSON.stringify(backupData, null, 2);
    const buffer = Buffer.from(serializedData, 'utf-8');
    const fileKey = `backups/backup_${Date.now()}.json`;

    // 2. 上传至 Cloudflare R2
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: fileKey,
        Body: buffer,
        ContentType: 'application/json',
      }),
    );

    const downloadUrl = `${process.env.R2_PUBLIC_URL}/${fileKey}`;

    // 3. 记录审计日志
    await this.auditLogService.log(
      username,
      'CREATE_BACKUP',
      `手动触发数据库备份，备份文件: ${fileKey}，包含 ${backupData.teams.length} 支球队、${backupData.players.length} 名球员。`,
    );

    return downloadUrl;
  }

  async listBackups() {
    try {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: process.env.R2_BUCKET_NAME,
          Prefix: 'backups/',
        }),
      );

      const files = response.Contents || [];
      return files
        .filter((file) => file.Key && file.Key.endsWith('.json'))
        .map((file) => {
          const key = file.Key || '';
          return {
            key,
            filename: key.replace('backups/', ''),
            size: file.Size || 0,
            lastModified: file.LastModified,
            downloadUrl: `${process.env.R2_PUBLIC_URL}/${key}`,
          };
        })
        .sort((a, b) => {
          const timeA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
          const timeB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
          return timeB - timeA; // 降序排序，最新的备份在最前
        });
    } catch (err) {
      console.error('获取 R2 备份列表失败:', err);
      return [];
    }
  }

  // 辅助还原方法 (事务保护)
  async restoreBackup(username: string, key: string): Promise<string> {
    try {
      // 1. 获取云端备份数据
      const s3Response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }),
      );

      const streamToString = (stream: any): Promise<string> =>
        new Promise((resolve, reject) => {
          const chunks: any[] = [];
          stream.on('data', (chunk: any) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });

      const jsonStr = await streamToString(s3Response.Body);
      const data = JSON.parse(jsonStr);

      if (!data.teams || !data.players || !data.matches) {
        throw new Error('无效的备份文件结构');
      }

      // 2. 清理表并重构数据
      await this.prisma.$transaction(async (tx) => {
        // 先删除有外键引用的记录
        await tx.goal.deleteMany();
        await tx.matchEvent.deleteMany();
        await tx.player.deleteMany();
        await tx.match.deleteMany();
        await tx.team.deleteMany();
        await tx.news.deleteMany();

        // 恢复数据
        if (data.teams.length > 0) {
          await tx.team.createMany({ data: data.teams });
        }
        if (data.players.length > 0) {
          await tx.player.createMany({ data: data.players });
        }
        if (data.matches.length > 0) {
          // 由于 Prisma model 中的 DateTime 字段需要将 JSON String 转换为 Date 对象
          const matches = data.matches.map((m: any) => ({
            ...m,
            matchDate: new Date(m.matchDate),
            createdAt: m.createdAt ? new Date(m.createdAt) : undefined,
            updatedAt: m.updatedAt ? new Date(m.updatedAt) : undefined,
          }));
          await tx.match.createMany({ data: matches });
        }
        if (data.goals && data.goals.length > 0) {
          const goals = data.goals.map((g: any) => ({
            ...g,
            createdAt: g.createdAt ? new Date(g.createdAt) : undefined,
          }));
          await tx.goal.createMany({ data: goals });
        }
        if (data.matchEvents && data.matchEvents.length > 0) {
          const events = data.matchEvents.map((e: any) => ({
            ...e,
            createdAt: e.createdAt ? new Date(e.createdAt) : undefined,
          }));
          await tx.matchEvent.createMany({ data: events });
        }
        if (data.news && data.news.length > 0) {
          const news = data.news.map((n: any) => ({
            ...n,
            publishedAt: n.publishedAt ? new Date(n.publishedAt) : undefined,
            createdAt: n.createdAt ? new Date(n.createdAt) : undefined,
            updatedAt: n.updatedAt ? new Date(n.updatedAt) : undefined,
          }));
          await tx.news.createMany({ data: news });
        }
      });

      // 3. 记录日志
      await this.auditLogService.log(
        username,
        'RESTORE_BACKUP',
        `从备份文件 ${key} 成功还原了数据库。`,
      );

      return '还原成功';
    } catch (err) {
      console.error('还原备份失败:', err);
      throw new Error(`还原备份失败: ${err instanceof Error ? err.message : '未知错误'}`);
    }
  }
}
