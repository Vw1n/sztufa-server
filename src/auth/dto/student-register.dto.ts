import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MinLength, MaxLength, Matches, IsNotEmpty } from 'class-validator';

export class StudentRegisterDto {
  @ApiProperty({ description: '用户名', example: 'zhangsan' })
  @IsString()
  @IsNotEmpty({ message: '用户名不能为空' })
  @MinLength(3, { message: '用户名最少 3 个字符' })
  @MaxLength(30, { message: '用户名最多 30 个字符' })
  username: string;

  @ApiProperty({ description: '学号', example: '2023123456' })
  @IsString()
  @IsNotEmpty({ message: '学号不能为空' })
  @Matches(/^[a-zA-Z0-9_-]{6,20}$/, {
    message: '学号格式必须为 6-20 位字母、数字或连字符',
  })
  studentId: string;

  @ApiProperty({ description: '密码', example: 'password123' })
  @IsString()
  @IsNotEmpty({ message: '密码不能为空' })
  @MinLength(6, { message: '密码最少 6 个字符' })
  @MaxLength(50, { message: '密码最多 50 个字符' })
  password: string;

  @ApiProperty({ description: '昵称', example: '张三', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(30, { message: '昵称最多 30 个字符' })
  nickname?: string;
}
