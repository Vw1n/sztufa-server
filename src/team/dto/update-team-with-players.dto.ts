import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CreateTeamPlayerDto } from './create-team-player.dto';

export class UpdateTeamPlayerItemDto extends CreateTeamPlayerDto {
  @ApiProperty({
    description: 'Existing player ID; omit only when creating a player',
    required: false,
  })
  @IsOptional()
  @IsString()
  id?: string;
}

export class UpdateTeamWithPlayersDto {
  @ApiProperty({ description: '球队名称', required: false })
  @IsOptional()
  @IsString()
  teamName?: string;

  @ApiProperty({ description: '队医', required: false })
  @IsOptional()
  @IsString()
  teamDoctor?: string;

  @ApiProperty({ description: '主教练', required: false })
  @IsOptional()
  @IsString()
  headCoach?: string;

  @ApiProperty({ description: '队长', required: false })
  @IsOptional()
  @IsString()
  teamLeader?: string;

  @ApiProperty({ description: '教练电话', required: false })
  @IsOptional()
  @IsString()
  coachPhone?: string;

  @ApiProperty({ description: '队长电话', required: false })
  @IsOptional()
  @IsString()
  leaderPhone?: string;

  @ApiProperty({ description: '主场球衣颜色', required: false })
  @IsOptional()
  @IsString()
  homeJerseyColor?: string;

  @ApiProperty({ description: '客场球衣颜色', required: false })
  @IsOptional()
  @IsString()
  awayJerseyColor?: string;

  @ApiProperty({ description: '球队Logo (Base64)', required: false })
  @IsOptional()
  @IsString()
  teamLogo?: string | null;

  @ApiProperty({ description: '主场球衣图片 (Base64)', required: false })
  @IsOptional()
  @IsString()
  homeJersey?: string | null;

  @ApiProperty({ description: '客场球衣图片 (Base64)', required: false })
  @IsOptional()
  @IsString()
  awayJersey?: string | null;

  @ApiProperty({ description: '球队性别组别 (MALE/FEMALE)', required: false })
  @IsOptional()
  @IsString()
  gender?: string;

  @ApiProperty({
    description:
      '球员操作列表: 新增的球员不带 id，更新的球员带 id，需删除的球员放在 deletePlayerIds',
    type: [UpdateTeamPlayerItemDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateTeamPlayerItemDto)
  players?: UpdateTeamPlayerItemDto[];

  @ApiProperty({
    description: '需要删除的球员 ID 列表',
    type: [String],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deletePlayerIds?: string[];
}
