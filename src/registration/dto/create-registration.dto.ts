import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateRegistrationDto {
  @ApiProperty({ description: '目标赛季 ID' })
  @IsNotEmpty({ message: '赛季 ID 不能为空' })
  @IsString({ message: '赛季 ID 必须为字符串' })
  seasonId: string;
}
