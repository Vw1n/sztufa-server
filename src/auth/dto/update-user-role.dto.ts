import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';

export class UpdateUserRoleDto {
  @ApiProperty({ description: '角色', example: 'coach' })
  @IsString()
  @IsEnum(['super_admin', 'coach', 'match_scorer', 'news_editor', 'user'], {
    message: '角色必须是 super_admin, coach, match_scorer, news_editor 或 user',
  })
  role: string;

  @ApiProperty({ description: '绑定球队ID', example: 'cuid...', required: false, nullable: true })
  @IsOptional()
  @IsString()
  teamId: string | null;
}
