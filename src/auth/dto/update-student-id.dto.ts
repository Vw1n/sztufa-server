import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Matches } from 'class-validator';

export class UpdateStudentIdDto {
  @ApiProperty({ description: '学号', example: '2023123456' })
  @IsString()
  @IsNotEmpty({ message: '学号不能为空' })
  @Matches(/^[a-zA-Z0-9_-]{6,20}$/, {
    message: '学号格式必须为 6-20 位字母、数字或连字符',
  })
  studentId: string;
}
