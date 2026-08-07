import { Module } from '@nestjs/common';
import { FormDraftController } from './form-draft.controller';
import { FormDraftService } from './form-draft.service';
import { FormDraftRecoveryService } from './form-draft-recovery.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TeamModule } from '../team/team.module';
import { MatchModule } from '../match/match.module';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [PrismaModule, TeamModule, MatchModule, UploadModule],
  controllers: [FormDraftController],
  providers: [FormDraftService, FormDraftRecoveryService],
  exports: [FormDraftService, FormDraftRecoveryService],
})
export class FormDraftModule {}
