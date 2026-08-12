import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BackupService } from './backup.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { BackupScope } from './backup-scope.service';

@Controller('api/v1/backups')
@ApiTags('备份管理')
export class BackupController {
  private scheduledBackupInFlight: ReturnType<BackupService['createScheduledBackup']> | null = null;

  constructor(private readonly backupService: BackupService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('create')
  @ApiOperation({ summary: '创建数据库备份并上传 R2 私有桶 (V3.0 GZIP)' })
  async create(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Body('scope') scope?: BackupScope,
    @Body('seasonId') seasonId?: string,
  ) {
    const username = req.user?.username || 'system';
    const abortController = new AbortController();

    const onAborted = () => abortController.abort();
    const onClose = () => {
      if (!res.writableEnded) abortController.abort();
    };

    req.on('aborted', onAborted);
    req.on('error', onAborted);
    res.on('close', onClose);

    try {
      const backupMetadata = await this.backupService.createBackup(username, {
        purpose: 'manual',
        scope,
        seasonId,
        signal: abortController.signal,
      });
      return { success: true, data: backupMetadata };
    } finally {
      req.off('aborted', onAborted);
      req.off('error', onAborted);
      res.off('close', onClose);
    }
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Get('list')
  @ApiOperation({ summary: '获取云端备份文件列表' })
  async list() {
    const list = await this.backupService.listBackups();
    return { success: true, data: list };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('download-url')
  @ApiOperation({ summary: '获取云端私有备份的短期预签名下载链接' })
  async getDownloadUrl(@Body('key') key: string) {
    const downloadUrl = await this.backupService.getPresignedDownloadUrl(key);
    return { success: true, downloadUrl };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('restore')
  @ApiOperation({ summary: '根据备份文件还原数据库' })
  async restore(
    @Req() req: any,
    @Body('key') key: string,
    @Body('confirmText') confirmText?: string,
  ) {
    const username = req.user?.username || 'system';
    const result = await this.backupService.restoreBackup(username, key, confirmText);
    return { success: true, message: result };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('upload/init')
  @ApiOperation({ summary: '初始化本地备份文件 R2 直传预签名 URL' })
  async initUpload(
    @Req() req: any,
    @Body('filename') filename: string,
    @Body('size') size: number,
    @Body('sha256') sha256: string,
  ) {
    const userId = req.user?.id || req.user?.sub || 'system';
    const username = req.user?.username || 'system';
    const result = await this.backupService.initUpload(userId, username, filename, size, sha256);
    return { success: true, data: result };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('upload/complete')
  @ApiOperation({ summary: '完成本地备份 R2 直传并触发合规校验与转存' })
  async completeUpload(@Req() req: any, @Body('uploadToken') uploadToken: string) {
    const userId = req.user?.id || req.user?.sub || 'system';
    const username = req.user?.username || 'system';
    const result = await this.backupService.completeUpload(userId, username, uploadToken);
    return { success: true, data: result };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Delete()
  @ApiOperation({ summary: '受控删除云端指定备份文件' })
  async deleteBackup(
    @Req() req: any,
    @Body('key') key: string,
    @Body('confirmText') confirmText?: string,
  ) {
    const username = req.user?.username || 'system';
    const message = await this.backupService.deleteBackup(username, key, confirmText);
    return { success: true, message };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('retention/clean')
  @ApiOperation({ summary: '执行备份保留策略 Dry-run 或自动清理' })
  async cleanRetention(
    @Req() req: any,
    @Body('dryRun') dryRun: boolean = true,
    @Body('confirmText') confirmText?: string,
  ) {
    const username = req.user?.username || 'system';
    const result = await this.backupService.cleanRetention(username, dryRun, confirmText);
    return { success: true, data: result };
  }

  @Post('auto-backup')
  @ApiOperation({ summary: 'Vercel Cron 自动定时备份接口' })
  async autoBackup(@Req() req: any, @Res({ passthrough: true }) res: any) {
    const authHeader = req.headers['authorization'];
    const expectedToken = `Bearer ${process.env.CRON_SECRET}`;

    if (!process.env.CRON_SECRET || authHeader !== expectedToken) {
      throw new ForbiddenException('未授权的定时备份请求');
    }

    const abortController = new AbortController();
    const onAborted = () => abortController.abort();
    const onClose = () => {
      if (!res.writableEnded) abortController.abort();
    };

    req.on('aborted', onAborted);
    req.on('error', onAborted);
    res.on('close', onClose);

    try {
      if (!this.scheduledBackupInFlight) {
        this.scheduledBackupInFlight = this.backupService.createScheduledBackup(
          'vercel-cron-system',
          {
            signal: abortController.signal,
          },
        );
      }
      const backupMetadata = await this.scheduledBackupInFlight;
      return { success: true, data: backupMetadata };
    } finally {
      this.scheduledBackupInFlight = null;
      req.off('aborted', onAborted);
      req.off('error', onAborted);
      res.off('close', onClose);
    }
  }
}
