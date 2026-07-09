import { PartialType, ApiProperty } from '@nestjs/swagger';
import { CreatePlayerDto } from './create-player.dto';
import { IsOptional, IsString, IsNumber } from 'class-validator';

export class UpdatePlayerDto extends PartialType(CreatePlayerDto) {
  @ApiProperty({ description: '球员状态', required: false, example: 'active' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ description: '黄牌数', required: false, example: 0 })
  @IsOptional()
  @IsNumber()
  yellowCards?: number;

  @ApiProperty({ description: '红牌数', required: false, example: 0 })
  @IsOptional()
  @IsNumber()
  redCards?: number;
}
