import { Module } from '@nestjs/common';
import { PublicSummaryController } from './public-summary.controller';
import { PublicSummaryService } from './public-summary.service';

@Module({
  controllers: [PublicSummaryController],
  providers: [PublicSummaryService],
})
export class PublicSummaryModule {}
