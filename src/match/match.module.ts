import { Module } from '@nestjs/common';
import { MatchController } from './match.controller';
import { MatchService } from './match.service';
import { PlayerCardSyncService } from './player-card-sync.service';
import { MatchQueryService } from './match-query.service';
import { MatchDataWriterService } from './match-data-writer.service';

import { PredictionModule } from '../prediction/prediction.module';

@Module({
  imports: [PredictionModule],
  controllers: [MatchController],
  providers: [MatchService, MatchQueryService, MatchDataWriterService, PlayerCardSyncService],
  exports: [MatchService, MatchQueryService, MatchDataWriterService, PlayerCardSyncService],
})
export class MatchModule {}
