import { Module } from '@nestjs/common';
import { MatchController } from './match.controller';
import { MatchService } from './match.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [MatchController],
  providers: [MatchService, PrismaService],
})
export class MatchModule {}
