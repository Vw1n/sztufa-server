import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CardSubmissionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[^\x00-\x1f\x7f]+$/)
  realName: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{6,20}$/)
  studentId: string;

  @Equals('campus-card-v1', { message: '请阅读并确认校园卡材料使用说明' })
  consentVersion: string;
}
export class MemberRegisterDto extends CardSubmissionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{3,30}$/)
  username: string;
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;
  @IsOptional()
  @IsString()
  @MaxLength(30)
  nickname?: string;
}
export class MemberListDto {
  @IsOptional() @IsString() @MaxLength(50) search?: string;
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'LEGACY']) status?: string;
  @Type(() => Number) @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class ReviewCardDto {
  @IsIn(['APPROVED', 'CHANGES_REQUESTED']) decision: string;
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
export class MemberStatusDto {
  @IsBoolean() disabled: boolean;
}
