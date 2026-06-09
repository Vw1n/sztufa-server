import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class CreateTeamDto {
  @ApiProperty({ description: '球队名称', example: '人工智能学院' })
  @IsString()
  teamName: string;

  @ApiProperty({ description: '队医', example: '张正扬', required: false })
  @IsOptional()
  @IsString()
  teamDoctor?: string;

  @ApiProperty({ description: '主教练', example: '谢子腾', required: false })
  @IsOptional()
  @IsString()
  headCoach?: string;

  @ApiProperty({ description: '队长', example: '罗圳城', required: false })
  @IsOptional()
  @IsString()
  teamLeader?: string;

  @ApiProperty({ description: '教练电话', example: '13913913913', required: false })
  @IsOptional()
  @IsString()
  coachPhone?: string;

  @ApiProperty({ description: '队长电话', example: '13513513513', required: false })
  @IsOptional()
  @IsString()
  leaderPhone?: string;

  @ApiProperty({ description: '主场球衣颜色', example: '蓝色' })
  @IsString()
  homeJerseyColor: string;

  @ApiProperty({ description: '客场球衣颜色', example: '白色' })
  @IsString()
  awayJerseyColor: string;

  @ApiProperty({ description: '球队Logo (Base64)', required: false })
  @IsOptional()
  @IsString()
  teamLogo?: string;

  @ApiProperty({ description: '主场球衣图片 (Base64)', required: false })
  @IsOptional()
  @IsString()
  homeJersey?: string;

  @ApiProperty({ description: '客场球衣图片 (Base64)', required: false })
  @IsOptional()
  @IsString()
  awayJersey?: string;
}
