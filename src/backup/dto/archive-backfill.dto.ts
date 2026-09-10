import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ArchiveBackfillPreviewDto {
  @ApiProperty({
    description:
      '指定补建的归档赛季 ID 列表（可选，默认扫描全部缺失保护的归档赛季，单批最多 10 个）',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: 'seasonIds 必须为数组' })
  @ArrayMaxSize(10, { message: '单次补建赛季数量不能超过 10 个' })
  @IsString({ each: true, message: 'seasonId 必须为字符串' })
  seasonIds?: string[];
}

export class ArchiveBackfillExecuteDto {
  @ApiProperty({
    description: '由 Preview 接口签发的 HMAC 防篡改预检 Token',
    required: true,
  })
  @IsNotEmpty({ message: 'backfillToken 不能为空' })
  @IsString({ message: 'backfillToken 必须为字符串' })
  backfillToken: string;

  @ApiProperty({
    description:
      '指定执行补建的归档赛季 ID 列表（必须包含在 backfillToken 许可的范围内，单批最多 10 个）',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: 'seasonIds 必须为数组' })
  @ArrayMaxSize(10, { message: '单次补建赛季数量不能超过 10 个' })
  @IsString({ each: true, message: 'seasonId 必须为字符串' })
  seasonIds?: string[];
}
