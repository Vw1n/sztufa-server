import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateTeamPlayerDto {
  @ApiProperty({ description: '球员姓名', example: '张三', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: '学号', example: '20210001', required: false })
  @IsOptional()
  @IsString()
  studentId?: string;

  @ApiProperty({ description: '球衣号码', example: '10', required: false })
  @IsOptional()
  @IsString()
  jerseyNumber?: string;

  @ApiProperty({ description: '球员照片 URL', required: false })
  @IsOptional()
  @IsString()
  photo?: string | null;

  @ApiProperty({ description: '球员状态', required: false, example: 'active' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ description: '黄牌数', required: false, example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  yellowCards?: number;

  @ApiProperty({ description: '红牌数', required: false, example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  redCards?: number;
}
