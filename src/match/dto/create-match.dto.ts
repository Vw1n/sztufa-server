import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsInt, IsOptional, IsDateString } from 'class-validator';

export class CreateMatchDto {
  @ApiProperty({ description: '主队ID' })
  @IsString()
  homeTeamId: string;

  @ApiProperty({ description: '客队ID' })
  @IsString()
  awayTeamId: string;

  @ApiProperty({ description: '主队比分', example: 2, required: false })
  @IsOptional()
  @IsInt()
  homeScore?: number;

  @ApiProperty({ description: '客队比分', example: 1, required: false })
  @IsOptional()
  @IsInt()
  awayScore?: number;

  @ApiProperty({ description: '比赛日期时间', example: '2024-01-15T14:00:00' })
  @IsDateString()
  matchDate: string;

  @ApiProperty({ description: '比赛地点', example: '学校足球场' })
  @IsString()
  location: string;

  @ApiProperty({ description: '比赛状态', example: 'scheduled', required: false })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ description: '进球列表', required: false })
  @IsOptional()
  goals?: any[];

  @ApiProperty({ description: '事件列表', required: false })
  @IsOptional()
  events?: any[];

  @ApiProperty({ description: '全场最佳球员ID', required: false })
  @IsOptional()
  @IsString()
  mvpPlayerId?: string;

  @ApiProperty({ description: '全场最佳球员姓名', required: false })
  @IsOptional()
  @IsString()
  mvpPlayerName?: string;
}
