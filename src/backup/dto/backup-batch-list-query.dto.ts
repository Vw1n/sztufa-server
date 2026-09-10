import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export class BackupBatchListQueryDto {
  @ApiProperty({
    description: '批次状态过滤',
    required: false,
    enum: ['running', 'succeeded', 'incomplete', 'failed'],
  })
  @IsOptional()
  @IsIn(['running', 'succeeded', 'incomplete', 'failed'], {
    message: 'status 参数非法，仅允许: running, succeeded, incomplete, failed',
  })
  status?: string;

  @ApiProperty({
    description: '月份周期键过滤，格式必须为 YYYY-MM (例如: 2026-09)',
    required: false,
    example: '2026-09',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'periodKey 参数格式非法，必须为 YYYY-MM (如 2026-09)',
  })
  periodKey?: string;

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
    description: '跳过记录数量（用于分页），默认 0',
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
