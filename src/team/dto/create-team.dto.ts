import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength, IsIn } from 'class-validator';

export class CreateTeamDto {
  @ApiProperty({ description: '球队名称', example: '人工智能学院', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: '球队名称长度不能超过100个字符' })
  teamName?: string;

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

  @ApiProperty({ description: '主场球衣颜色', example: '蓝色', required: false })
  @IsOptional()
  @IsString()
  homeJerseyColor?: string;

  @ApiProperty({ description: '客场球衣颜色', example: '白色', required: false })
  @IsOptional()
  @IsString()
  awayJerseyColor?: string;

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

  @ApiProperty({ description: '球队性别组别 (MALE/FEMALE)', example: 'MALE', required: false })
  @IsOptional()
  @IsString()
  @IsIn(['MALE', 'FEMALE'], { message: '球队性别组别必须是 MALE(男子) 或 FEMALE(女子)' })
  gender?: string;
}
