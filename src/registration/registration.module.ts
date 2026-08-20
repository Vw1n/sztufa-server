import { Module } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { TeamModule } from '../team/team.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [TeamModule, AuditLogModule],
  controllers: [RegistrationController],
  providers: [RegistrationService],
  exports: [RegistrationService],
})
export class RegistrationModule {}
