import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { TeamModule } from './team/team.module';
import { PlayerModule } from './player/player.module';
import { MatchModule } from './match/match.module';
import { ImportModule } from './import/import.module';
import { UploadModule } from './upload/upload.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { BackupModule } from './backup/backup.module';
import { SeasonModule } from './season/season.module';
import { NewsModule } from './news/news.module';
import { PrismaModule } from './prisma/prisma.module';
import { PredictionModule } from './prediction/prediction.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,
        limit: 60,
      },
      {
        name: 'strict',
        ttl: 60000,
        limit: 5,
      },
    ]),
    PrismaModule,
    AuthModule,
    TeamModule,
    PlayerModule,
    MatchModule,
    ImportModule,
    UploadModule,
    AuditLogModule,
    BackupModule,
    SeasonModule,
    NewsModule,
    PredictionModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
