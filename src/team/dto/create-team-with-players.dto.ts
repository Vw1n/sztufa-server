import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import { CreateTeamDto } from './create-team.dto';
import { CreateTeamPlayerDto } from './create-team-player.dto';

export class CreateTeamWithPlayersDto extends CreateTeamDto {
  @ApiProperty({ description: '球队和球员要加入的活跃赛季 ID' })
  @IsString()
  @IsNotEmpty()
  seasonId: string;

  @ApiProperty({
    description: '随球队一同创建的球员列表',
    type: [CreateTeamPlayerDto],
  })
  @IsArray()
  @ArrayMinSize(1, { message: '请至少添加一名球员' })
  @ValidateNested({ each: true })
  @Type(() => CreateTeamPlayerDto)
  players: CreateTeamPlayerDto[];
}
