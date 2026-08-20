import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

export class RegistrationTeamDataDto {
  @ApiProperty({ description: '球队名称' })
  @IsOptional()
  @IsString()
  teamName?: string;

  @ApiProperty({ description: '队医' })
  @IsOptional()
  @IsString()
  teamDoctor?: string;

  @ApiProperty({ description: '主教练' })
  @IsOptional()
  @IsString()
  headCoach?: string;

  @ApiProperty({ description: '领队' })
  @IsOptional()
  @IsString()
  teamLeader?: string;

  @ApiProperty({ description: '教练电话' })
  @IsOptional()
  @IsString()
  coachPhone?: string;

  @ApiProperty({ description: '领队电话' })
  @IsOptional()
  @IsString()
  leaderPhone?: string;

  @ApiProperty({ description: '主场球衣颜色' })
  @IsOptional()
  @IsString()
  homeJerseyColor?: string;

  @ApiProperty({ description: '客场球衣颜色' })
  @IsOptional()
  @IsString()
  awayJerseyColor?: string;

  @ApiProperty({ description: '球队 Logo' })
  @IsOptional()
  @IsString()
  teamLogo?: string;

  @ApiProperty({ description: '主场球衣图片' })
  @IsOptional()
  @IsString()
  homeJersey?: string;

  @ApiProperty({ description: '客场球衣图片' })
  @IsOptional()
  @IsString()
  awayJersey?: string;

  @ApiProperty({ description: '组别 MALE/FEMALE' })
  @IsOptional()
  @IsString()
  gender?: string;
}

export class RegistrationPlayerDto {
  @ApiProperty({ description: '关联的正式球员 ID (可选)', required: false })
  @IsOptional()
  @IsString()
  playerId?: string;

  @ApiProperty({ description: '球员姓名' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: '学号' })
  @IsOptional()
  @IsString()
  studentId?: string;

  @ApiProperty({ description: '球衣号码' })
  @IsOptional()
  @IsString()
  jerseyNumber?: string;

  @ApiProperty({ description: '照片 URL' })
  @IsOptional()
  @IsString()
  photo?: string;
}

export class SaveRegistrationDto {
  @ApiProperty({ description: '球队资料', required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => RegistrationTeamDataDto)
  teamData?: RegistrationTeamDataDto;

  @ApiProperty({ description: '球员名单', type: [RegistrationPlayerDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegistrationPlayerDto)
  players?: RegistrationPlayerDto[];
}
