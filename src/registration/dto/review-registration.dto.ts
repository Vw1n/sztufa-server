import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewRegistrationDto {
  @ApiProperty({ description: '审核意见 / 退回说明', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: '审核意见不能超过 2000 个字符' })
  reviewComment?: string;
}
