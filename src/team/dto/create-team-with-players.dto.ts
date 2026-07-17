import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, ValidateNested } from 'class-validator';
import { CreateTeamDto } from './create-team.dto';
import { CreateTeamPlayerDto } from './create-team-player.dto';

export class CreateTeamWithPlayersDto extends CreateTeamDto {
  @ApiProperty({
    description: '随球队一同创建的球员列表',
    type: [CreateTeamPlayerDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTeamPlayerDto)
  players?: CreateTeamPlayerDto[];
}
