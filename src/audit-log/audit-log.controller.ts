import { Controller, Get, Query, UseGuards, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuditLogService } from './audit-log.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/v1/audit-logs')
@ApiTags('审计日志')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('super_admin')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @ApiBearerAuth()
  @Get()
  @ApiOperation({ summary: '获取审计日志列表（仅限管理员）' })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('username') username?: string,
    @Query('action') action?: string,
  ) {
    return this.auditLogService.findAll(page, limit, username, action);
  }
}
