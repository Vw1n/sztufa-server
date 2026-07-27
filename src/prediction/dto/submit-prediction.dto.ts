import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { PredictionChoice } from '@prisma/client';

export class SubmitPredictionDto {
  @ApiProperty({
    description: '竞猜选择',
    enum: PredictionChoice,
    example: 'HOME_WIN',
  })
  @IsEnum(PredictionChoice, {
    message: 'choice 必须是 HOME_WIN, DRAW 或 AWAY_WIN',
  })
  choice: PredictionChoice;
}
