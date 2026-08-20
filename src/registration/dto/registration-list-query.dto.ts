import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsEnum, IsOptional, IsString, Min, Max } from 'class-validator';
import { RegistrationStatus } from '@prisma/client';

export class RegistrationListQueryDto {
  @ApiProperty({ description: '赛季 ID 筛选', required: false })
  @IsOptional()
  @IsString()
  seasonId?: string;

  @ApiProperty({ description: '状态筛选', enum: RegistrationStatus, required: false })
  @IsOptional()
  @IsEnum(RegistrationStatus, { message: '无效的状态参数' })
  status?: RegistrationStatus;

  @ApiProperty({ description: '页码', required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ description: '每页条数', required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
