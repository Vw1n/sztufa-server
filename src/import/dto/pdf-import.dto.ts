import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ParsedFieldDto<T = string> {
  @ApiProperty({ description: '字段属性值' })
  @IsOptional()
  value: T | null;

  @ApiProperty({ description: '匹配置信度 (0.0 - 1.0)' })
  @IsNumber()
  confidence: number;

  @ApiProperty({ description: '页码' })
  @IsNumber()
  page: number;

  @ApiPropertyOptional({ description: '匹配警告信息', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  warnings?: string[];

  @ApiPropertyOptional({ description: '管理员是否已人工核对确认' })
  @IsOptional()
  @IsBoolean()
  manuallyConfirmed?: boolean;
}

export class ParsedPlayerDto {
  @ApiProperty({ description: '姓名' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  name: ParsedFieldDto<string>;

  @ApiProperty({ description: '学号' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  studentId: ParsedFieldDto<string>;

  @ApiProperty({ description: '球衣号码' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  jerseyNumber: ParsedFieldDto<string>;

  @ApiProperty({ description: '球员照片临时 URL / Key' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  photo: ParsedFieldDto<string>;

  @ApiProperty({ description: '是否需要人工二次确认' })
  @IsBoolean()
  needsManualConfirm: boolean;
}

export class ParsedTeamDto {
  @ApiProperty({ description: '球队名称' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  teamName: ParsedFieldDto<string>;

  @ApiProperty({ description: '主教练姓名' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  headCoach: ParsedFieldDto<string>;

  @ApiProperty({ description: '主教练联系方式' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  coachPhone: ParsedFieldDto<string>;

  @ApiProperty({ description: '领队姓名' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  teamLeader: ParsedFieldDto<string>;

  @ApiProperty({ description: '领队联系方式' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  leaderPhone: ParsedFieldDto<string>;

  @ApiProperty({ description: '队医姓名' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  teamDoctor: ParsedFieldDto<string>;

  @ApiProperty({ description: '主队球衣颜色' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  homeJerseyColor: ParsedFieldDto<string>;

  @ApiProperty({ description: '客队球衣颜色' })
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  awayJerseyColor: ParsedFieldDto<string>;

  @ApiPropertyOptional({ description: '队徽临时 URL' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  logo?: ParsedFieldDto<string>;

  @ApiPropertyOptional({ description: '主场球衣临时 URL' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  homeJerseyPhoto?: ParsedFieldDto<string>;

  @ApiPropertyOptional({ description: '客场球衣临时 URL' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ParsedFieldDto)
  awayJerseyPhoto?: ParsedFieldDto<string>;

  @ApiProperty({ description: '球员名单', type: [ParsedPlayerDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParsedPlayerDto)
  players: ParsedPlayerDto[];
}

export class PdfPreviewResponseDto {
  @ApiProperty({ description: '批次唯一 ID' })
  @IsString()
  batchId: string;

  @ApiProperty({ description: '文件 SHA-256 哈希摘要' })
  @IsString()
  fileHash: string;

  @ApiProperty({ description: '批次过期时间 (ISO 时间戳)' })
  @IsString()
  expiresAt: string;

  @ApiProperty({ description: '解析出的球队与球员列表', type: [ParsedTeamDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParsedTeamDto)
  teams: ParsedTeamDto[];

  @ApiProperty({ description: '是否存在低置信度警告项' })
  @IsBoolean()
  hasLowConfidence: boolean;
}

export class PdfCommitRequestDto {
  @ApiProperty({ description: '校对并允许编辑后的球队数据列表', type: [ParsedTeamDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParsedTeamDto)
  teams: ParsedTeamDto[];

  @ApiPropertyOptional({ description: '绑定的赛季 ID' })
  @IsOptional()
  @IsString()
  seasonId?: string;
}

export class PdfUploadUrlRequestDto {
  @ApiProperty({ description: '原始 PDF 文件名' })
  @IsString()
  fileName: string;

  @ApiProperty({ description: 'PDF 文件大小（字节）' })
  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  fileSize: number;

  @ApiProperty({ description: '文件 MIME 类型', default: 'application/pdf' })
  @IsString()
  mimeType: string;
}

export class PdfUploadUrlResponseDto {
  @ApiProperty({ description: 'R2/S3 预签名 PUT 地址' })
  uploadUrl: string;

  @ApiProperty({ description: '上传后用于预览解析的临时对象 Key' })
  objectKey: string;

  @ApiProperty({ description: '预签名地址过期时间' })
  expiresAt: string;
}

export class PdfPreviewUploadedRequestDto {
  @ApiProperty({ description: '预签名流程返回的临时 PDF 对象 Key' })
  @IsString()
  objectKey: string;

  @ApiProperty({ description: '原始 PDF 文件名' })
  @IsString()
  fileName: string;

  @ApiProperty({ description: '浏览器选择文件时记录的大小（字节）' })
  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  fileSize: number;
}

export class PdfAssetRequestDto {
  @ApiProperty({ description: '预览批次中的临时图片 URL' })
  @IsString()
  url: string;
}

export class PdfCommitResponseDto {
  @ApiProperty({ description: '提示消息' })
  message: string;

  @ApiProperty({ description: '批次 ID' })
  batchId: string;

  @ApiProperty({ description: '已创建或更新的球队数量' })
  createdTeamsCount: number;

  @ApiProperty({ description: '已创建或更新的球员数量' })
  createdPlayersCount: number;
}

export class PdfCancelResponseDto {
  @ApiProperty({ description: '提示消息' })
  message: string;

  @ApiProperty({ description: '批次 ID' })
  batchId: string;
}

export class PdfRecoveryResponseDto {
  @ApiProperty({ description: '提示消息' })
  message: string;

  @ApiProperty({ description: '清理的僵死批次数量' })
  recoveredBatchesCount: number;
}
