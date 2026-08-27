import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MinLength, IsEnum } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ description: '用户名', example: 'admin' })
  @IsString()
  @MinLength(3)
  username: string;

  @ApiProperty({ description: '学号', example: '2023123456', required: false })
  @IsOptional()
  @IsString()
  studentId?: string;

  @ApiProperty({ description: '昵称', example: '张三', required: false })
  @IsOptional()
  @IsString()
  nickname?: string;

  @ApiProperty({ description: '密码', example: 'password123' })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ description: '角色', example: 'admin', required: false })
  @IsOptional()
  @IsString()
  @IsEnum(['super_admin', 'coach', 'match_scorer', 'news_editor'], {
    message: '角色必须是 super_admin, coach, match_scorer, news_editor',
  })
  role?: string;

  @ApiProperty({ description: '所辖球队ID', example: 'cuid...', required: false })
  @IsOptional()
  @IsString()
  teamId?: string;
}
