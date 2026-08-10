import { IsNotEmpty, IsString, ValidateIf } from 'class-validator';

export class UpdateSeasonChampionDto {
  @ValidateIf((_object, value) => value !== null)
  @IsString({ message: 'teamId 必须是字符串或 null' })
  @IsNotEmpty({ message: 'teamId 不能为空字符串' })
  teamId!: string | null;
}
