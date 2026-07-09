import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BackupService } from './backup.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/v1/backups')
@ApiTags('备份管理')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('super_admin')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('create')
  @ApiOperation({ summary: '创建数据库备份并上传 R2' })
  async create(@Req() req: any) {
    const username = req.user?.username || 'system';
    const downloadUrl = await this.backupService.createBackup(username);
    return { success: true, downloadUrl };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('list')
  @ApiOperation({ summary: '获取云端备份文件列表' })
  async list() {
    const list = await this.backupService.listBackups();
    return { success: true, data: list };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('restore')
  @ApiOperation({ summary: '根据备份文件还原数据库' })
  async restore(@Req() req: any, @Body('key') key: string) {
    const username = req.user?.username || 'system';
    const result = await this.backupService.restoreBackup(username, key);
    return { success: true, message: result };
  }
}
