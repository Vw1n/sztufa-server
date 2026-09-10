import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class BackupRunListQueryDto {
  @ApiProperty({
    description: '模块过滤',
    required: false,
    enum: ['season', 'staff', 'members', 'content', 'operations', 'full'],
  })
  @IsOptional()
  @IsIn(['season', 'staff', 'members', 'content', 'operations', 'full'], {
    message: 'module 参数非法，仅允许: season, staff, members, content, operations, full',
  })
  module?: string;

  @ApiProperty({
    description: '运行状态过滤',
    required: false,
    enum: ['pending', 'running', 'succeeded', 'skipped', 'failed'],
  })
  @IsOptional()
  @IsIn(['pending', 'running', 'succeeded', 'skipped', 'failed'], {
    message: 'status 参数非法，仅允许: pending, running, succeeded, skipped, failed',
  })
  status?: string;

  @ApiProperty({
    description: '触发源过滤',
    required: false,
    enum: ['manual', 'cron', 'archive', 'backfill', 'retry', 'pre-restore'],
  })
  @IsOptional()
  @IsIn(['manual', 'cron', 'archive', 'backfill', 'retry', 'pre-restore'], {
    message: 'trigger 参数非法，仅允许: manual, cron, archive, backfill, retry, pre-restore',
  })
  trigger?: string;

  @ApiProperty({
    description: '关联批次 ID 过滤',
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'batchId 必须为字符串' })
  batchId?: string;

  @ApiProperty({
    description: '选择器键过滤 (如 season:season_123 或 staff)',
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'selectorKey 必须为字符串' })
  selectorKey?: string;

  @ApiProperty({
    description: '返回记录数量限制 (1-100)，默认 20',
    required: false,
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit 必须为整数' })
  @Min(1, { message: 'limit 最小值为 1' })
  @Max(100, { message: 'limit 最大值为 100' })
  limit?: number = 20;

  @ApiProperty({
    description: '记录偏移量 (>= 0)，默认 0',
    required: false,
    default: 0,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset 必须为整数' })
  @Min(0, { message: 'offset 最小值为 0' })
  offset?: number = 0;
}
