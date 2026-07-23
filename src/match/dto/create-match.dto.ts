import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsInt,
  IsOptional,
  IsDateString,
  IsArray,
  ValidateNested,
  IsIn,
  IsEnum,
  IsNotEmpty,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum MatchEventType {
  Goal = 'goal',
  Penalty = 'penalty',
  PenaltyMiss = 'penalty_miss',
  OwnGoal = 'own_goal',
  Substitution = 'substitution',
  YellowCard = 'yellow_card',
  RedCard = 'red_card',
  YellowToRed = 'yellow_to_red',
  PenaltyShootoutGoal = 'penalty_shootout_goal',
  PenaltyShootoutMiss = 'penalty_shootout_miss',
}

export enum MatchEventPhase {
  Regular = 'REGULAR',
  ExtraTime = 'EXTRA_TIME',
  Shootout = 'SHOOTOUT',
}

const isShootoutEvent = (eventType: MatchEventType): boolean =>
  eventType === MatchEventType.PenaltyShootoutGoal ||
  eventType === MatchEventType.PenaltyShootoutMiss;

export class MatchEventDto {
  @ApiProperty({ description: '事件时间', example: "35'" })
  @IsString()
  @IsNotEmpty()
  eventTime: string;

  @ApiProperty({ enum: MatchEventType, description: '事件类型' })
  @IsEnum(MatchEventType)
  eventType: MatchEventType;

  @ApiProperty({ enum: MatchEventPhase, required: false, default: MatchEventPhase.Regular })
  @IsOptional()
  @IsEnum(MatchEventPhase)
  phase?: MatchEventPhase;

  @ApiProperty({ description: '点球大战轮次', required: false, minimum: 1 })
  @ValidateIf((event: MatchEventDto) => isShootoutEvent(event.eventType))
  @IsInt()
  @Min(1)
  shootoutRound?: number;

  @ApiProperty({ description: '点球大战全局罚球顺序', required: false, minimum: 1 })
  @ValidateIf((event: MatchEventDto) => isShootoutEvent(event.eventType))
  @IsInt()
  @Min(1)
  shootoutOrder?: number;

  @ApiProperty({ description: '事件描述' })
  @IsString()
  description: string;

  @ApiProperty({ enum: ['home', 'away'], description: '事件归属方' })
  @IsIn(['home', 'away'])
  teamType: 'home' | 'away';

  @IsOptional()
  @IsString()
  playerId?: string | null;

  @IsOptional()
  @IsString()
  playerName?: string | null;

  @IsOptional()
  @IsString()
  jerseyNumber?: string | null;

  @IsOptional()
  @IsString()
  subPlayerId?: string | null;

  @IsOptional()
  @IsString()
  subPlayerName?: string | null;

  @IsOptional()
  @IsString()
  subJerseyNumber?: string | null;

  @IsOptional()
  @IsString()
  assistPlayerId?: string | null;

  @IsOptional()
  @IsString()
  assistPlayerName?: string | null;

  @IsOptional()
  @IsString()
  assistJerseyNumber?: string | null;
}

export class CreateMatchDto {
  @ApiProperty({ description: '主队ID' })
  @IsString()
  homeTeamId: string;

  @ApiProperty({ description: '客队ID' })
  @IsString()
  awayTeamId: string;

  @ApiProperty({ description: '主队比分', example: 2, required: false })
  @IsOptional()
  @IsInt()
  @Min(0, { message: '主队比分不能为负数' })
  homeScore?: number;

  @ApiProperty({ description: '客队比分', example: 1, required: false })
  @IsOptional()
  @IsInt()
  @Min(0, { message: '客队比分不能为负数' })
  awayScore?: number;

  @ApiProperty({ description: '比赛日期时间', example: '2024-01-15T14:00:00' })
  @IsDateString()
  matchDate: string;

  @ApiProperty({ description: '比赛地点', example: '学校足球场' })
  @IsString()
  location: string;

  @ApiProperty({ description: '比赛状态', example: 'scheduled', required: false })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ description: '进球列表', required: false })
  @IsOptional()
  goals?: any[];

  @ApiProperty({ description: '事件列表', required: false, type: [MatchEventDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MatchEventDto)
  events?: MatchEventDto[];

  @ApiProperty({ description: '全场最佳球员ID', required: false })
  @IsOptional()
  @IsString()
  mvpPlayerId?: string;

  @ApiProperty({ description: '全场最佳球员姓名', required: false })
  @IsOptional()
  @IsString()
  mvpPlayerName?: string;

  @ApiProperty({ description: '赛季ID', required: false })
  @IsOptional()
  @IsString()
  seasonId?: string;

  @ApiProperty({ description: '比赛阶段', example: 'LEAGUE', required: false })
  @IsOptional()
  @IsString()
  stage?: string;

  @ApiProperty({ description: '小组名称', example: 'A', required: false })
  @IsOptional()
  @IsString()
  groupName?: string;

  @ApiProperty({ description: '淘汰赛轮次', example: 'R16', required: false })
  @IsOptional()
  @IsString()
  knockoutRound?: string;

  @ApiProperty({ description: '淘汰赛序号', example: 1, required: false })
  @IsOptional()
  @IsInt()
  knockoutMatchIndex?: number;

  @ApiProperty({ description: '比赛阵容列表', required: false, type: 'array' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MatchLineupDto)
  lineups?: MatchLineupDto[];
}

export class MatchLineupDto {
  @ApiProperty({ description: '球员ID' })
  @IsString()
  playerId: string;

  @ApiProperty({ description: '归属方', example: 'home' })
  @IsString()
  @IsIn(['home', 'away'])
  teamType: 'home' | 'away';

  @ApiProperty({ description: '阵容类型', example: 'starting' })
  @IsString()
  @IsIn(['starting', 'substitute'])
  lineupType: 'starting' | 'substitute';
}
