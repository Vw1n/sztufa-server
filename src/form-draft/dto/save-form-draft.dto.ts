import { IsOptional, IsString, IsObject } from 'class-validator';

export class SaveFormDraftDto {
  @IsOptional()
  @IsString()
  formType?: string; // 'TEAM' | 'MATCH'

  @IsOptional()
  @IsObject()
  payload?: Record<string, any>;

  @IsOptional()
  @IsString()
  seasonId?: string | null;

  @IsOptional()
  @IsString()
  officialRecordId?: string | null;
}
