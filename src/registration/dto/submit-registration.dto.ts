import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class SubmitRegistrationDto {
  @ApiProperty({ description: '提交附加备注 (可选)', required: false })
  @IsOptional()
  @IsString()
  comment?: string;
}
