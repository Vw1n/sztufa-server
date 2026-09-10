import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Req,
  Res,
  Query,
  Param,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BackupService } from './backup.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { BackupScope } from './backup-scope.service';
import { BackupModule } from './backup-module-registry';
import { BackupBatchListQueryDto } from './dto/backup-batch-list-query.dto';
import { BackupRunListQueryDto } from './dto/backup-run-list-query.dto';
import { ArchiveBackfillPreviewDto, ArchiveBackfillExecuteDto } from './dto/archive-backfill.dto';

@Controller('api/v1/backups')
@ApiTags('备份管理')
export class BackupController {
  private scheduledBackupInFlight: ReturnType<BackupService['createScheduledBackupBatch']> | null =
    null;

  constructor(private readonly backupService: BackupService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('create')
  @ApiOperation({ summary: '创建数据库备份并上传 R2 私有桶 (V3.0 GZIP)' })
  async create(
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
    @Body('scope') scope?: BackupScope | 'module',
    @Body('seasonId') seasonId?: string,
    @Body('module') module?: BackupModule,
    @Body('selector') selector?: Record<string, string>,
    @Body('purpose') purpose?: 'manual' | 'archive',
    @Body('protected') isProtected?: boolean,
  ) {
    const username = req.user?.username || 'system';
    const finalPurpose = purpose || 'manual';
    const finalProtected = !!isProtected;
    const finalSelector = selector ? { ...selector } : {};
    if (seasonId && !finalSelector.seasonId) {
      finalSelector.seasonId = seasonId;
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
      const backupMetadata = await this.backupService.createBackup(username, {
        purpose: finalPurpose,
        protected: finalProtected,
        scope,
        seasonId,
        module,
        selector: finalSelector,
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
  @Post('restore/preview')
  @ApiOperation({ summary: '预检 V4 模块备份恢复影响并签发短时恢复令牌' })
  async previewRestore(@Req() req: any, @Body('key') key: string) {
    const username = req.user?.username || 'system';
    const result = await this.backupService.previewRestore(username, key);
    return { success: true, data: result };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('restore/module')
  @ApiOperation({ summary: '使用 Preview 令牌执行 V4 模块恢复' })
  async restoreModule(
    @Req() req: any,
    @Body('key') key: string,
    @Body('restoreToken') restoreToken: string,
    @Body('confirmText') confirmText?: string,
  ) {
    const username = req.user?.username || 'system';
    const message = await this.backupService.restoreModuleBackup(
      username,
      key,
      restoreToken,
      confirmText,
    );
    return { success: true, message };
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

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Get('batches')
  @ApiOperation({ summary: '分页/条件查询月度备份批次列表' })
  async listBatches(@Query() query: BackupBatchListQueryDto) {
    const batches = await this.backupService.listBackupBatches(query);
    return { success: true, data: batches };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Get('batches/:id')
  @ApiOperation({ summary: '获取指定月度备份批次详情' })
  async getBatch(@Param('id') id: string) {
    const batch = await this.backupService.getBackupBatch(id);
    return { success: true, data: batch };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('batches/:id/retry')
  @ApiOperation({ summary: '人工触发未完成月度备份批次的断点重试' })
  async retryBatch(@Req() req: any, @Param('id') id: string) {
    const username = req.user?.username || 'system';
    const batchResult = await this.backupService.retryScheduledBackupBatch(id, username);
    return { success: true, data: batchResult };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'super_admin')
  @Get('runs')
  @ApiOperation({ summary: '分页/条件查询备份运行记录账本' })
  async listRuns(@Query() query: BackupRunListQueryDto) {
    const data = await this.backupService.listBackupRuns(query);
    return { success: true, data };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('runs/:runId/retry')
  @ApiOperation({ summary: '人工重试单个失败的模块备份任务' })
  async retryRun(@Req() req: any, @Param('runId') runId: string) {
    const username = req.user?.username || 'system';
    const result = await this.backupService.retryBackupRun(runId, username);
    return { success: true, data: result };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'super_admin')
  @Get('dashboard')
  @ApiOperation({ summary: '获取备份概览与双轨流量预算监控看板' })
  async getDashboard() {
    const data = await this.backupService.getDashboard();
    return { success: true, data };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'super_admin')
  @Get('metrics/summary')
  @ApiOperation({ summary: '获取当月或指定月份备份流量指标与双维度同口径基线比对' })
  async getMetricsSummary(@Query('periodKey') periodKey?: string) {
    const data = await this.backupService.getMetricsSummary(periodKey);
    return { success: true, data };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'super_admin')
  @Get('metrics/timeseries')
  @ApiOperation({ summary: '获取历史月度备份流量与运行趋势' })
  async getMetricsTimeseries(@Query('months') months?: string) {
    const monthsCount = months ? parseInt(months, 10) : 6;
    const data = await this.backupService.getMetricsTimeseries(monthsCount);
    return { success: true, data };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'super_admin')
  @Get('checkpoints')
  @ApiOperation({ summary: '查询各模块最新备份基线 Checkpoint 清单' })
  async listCheckpoints(
    @Query('module') module?: string,
    @Query('selectorKey') selectorKey?: string,
  ) {
    const data = await this.backupService.listBackupCheckpoints({ module, selectorKey });
    return { success: true, data };
  }

  @Post('auto-backup')
  @ApiOperation({ summary: 'Vercel Cron 自动定时备份接口' })
  async autoBackup(@Req() req: any) {
    const authHeader = req.headers['authorization'];
    const expectedToken = `Bearer ${process.env.CRON_SECRET}`;

    if (!process.env.CRON_SECRET || authHeader !== expectedToken) {
      throw new ForbiddenException('未授权的定时备份请求');
    }

    if (!this.scheduledBackupInFlight) {
      this.scheduledBackupInFlight = this.backupService
        .createScheduledBackupBatch('vercel-cron-system')
        .finally(() => {
          this.scheduledBackupInFlight = null;
        });
    }

    const batchResult = await this.scheduledBackupInFlight;
    return { success: true, data: batchResult };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Get('archive-coverage')
  @ApiOperation({ summary: '获取所有已归档赛季的保护备份覆盖率状态' })
  async getArchiveCoverage() {
    const coverage = await this.backupService.scanArchiveCoverage();
    return { success: true, data: coverage };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('archive-backfill/preview')
  @ApiOperation({ summary: '预检归档保护备份补建影响并签发单次防篡改 Token' })
  async previewArchiveBackfill(@Req() req: any, @Body() dto: ArchiveBackfillPreviewDto) {
    const operatorId = req.user?.id || req.user?.username || 'admin';
    const preview = await this.backupService.previewArchiveBackfill(operatorId, dto.seasonIds);
    return { success: true, data: preview };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('archive-backfill/execute')
  @ApiOperation({ summary: '使用 Preview Token 执行归档保护备份批量补建（受预算与并发锁保护）' })
  async executeArchiveBackfill(@Req() req: any, @Body() dto: ArchiveBackfillExecuteDto) {
    const operatorId = req.user?.id || req.user?.username || 'admin';
    const username = req.user?.username || 'system';
    const result = await this.backupService.executeArchiveBackfill(
      operatorId,
      username,
      dto.backfillToken,
      dto.seasonIds,
    );
    return { success: true, data: result };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('archive-backfill/:seasonId/retry')
  @ApiOperation({ summary: '人工重试单个失败的已归档赛季保护备份' })
  async retryArchiveBackfill(@Req() req: any, @Param('seasonId') seasonId: string) {
    const username = req.user?.username || 'system';
    const result = await this.backupService.retryArchiveSeasonBackfill(seasonId, username);
    return { success: true, data: result };
  }
}
