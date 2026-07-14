import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber } from 'class-validator';

export class CreatePlayerDto {
  @ApiProperty({ description: '球员姓名', example: '张三' })
  @IsString()
  name: string;

  @ApiProperty({ description: '学号', example: '20210001' })
  @IsString()
  studentId: string;

  @ApiProperty({ description: '球衣号码', example: '10' })
  @IsString()
  jerseyNumber: string;

  @ApiProperty({ description: '球员照片 (Base64)', required: false })
  @IsOptional()
  @IsString()
  photo?: string;

  @ApiProperty({ description: '所属球队ID' })
  @IsString()
  teamId: string;

  @ApiProperty({ description: '球员状态', required: false, example: 'active' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ description: '黄牌数', required: false, example: 0 })
  @IsOptional()
  @IsNumber()
  yellowCards?: number;

  @ApiProperty({ description: '红牌数', required: false, example: 0 })
  @IsOptional()
  @IsNumber()
  redCards?: number;
}
