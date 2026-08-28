import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: '用户名', example: 'admin' })
  @IsString()
  @MaxLength(128)
  username: string;

  @ApiProperty({ description: '密码', example: 'password123' })
  @IsString()
  @MaxLength(128)
  password: string;
}
