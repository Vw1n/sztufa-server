import { Controller, Get } from '@nestjs/common';
import { PublicSummaryService } from './public-summary.service';

@Controller('api/v1/public')
export class PublicSummaryController {
  constructor(private readonly summaryService: PublicSummaryService) {}

  @Get('summary')
  getSummary() {
    return this.summaryService.getSummary();
  }
}
