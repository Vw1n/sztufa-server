import { Controller, Get, Post, Body, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BackupService } from './backup.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/v1/backups')
@ApiTags('备份管理')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post('create')
  @ApiOperation({ summary: '创建数据库备份并上传 R2' })
  async create(@Req() req: any) {
    const username = req.user?.username || 'system';
    const downloadUrl = await this.backupService.createBackup(username);
    return { success: true, downloadUrl };
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
  @Post('restore')
  @ApiOperation({ summary: '根据备份文件还原数据库' })
  async restore(@Req() req: any, @Body('key') key: string) {
    const username = req.user?.username || 'system';
    const result = await this.backupService.restoreBackup(username, key);
    return { success: true, message: result };
  }

  @Post('auto-backup')
  @ApiOperation({ summary: 'Vercel Cron 自动定时备份接口' })
  async autoBackup(@Req() req: any) {
    const authHeader = req.headers['authorization'];
    const expectedToken = `Bearer ${process.env.CRON_SECRET}`;

    // 默认拒绝模式：必须配置 CRON_SECRET 且 Token 完全匹配才允许执行备份，防止未授权的数据导出漏洞
    if (!process.env.CRON_SECRET || authHeader !== expectedToken) {
      throw new ForbiddenException('未授权的定时备份请求');
    }

    const downloadUrl = await this.backupService.createBackup('vercel-cron-system');
    return { success: true, downloadUrl };
  }
}
