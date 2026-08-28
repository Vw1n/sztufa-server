import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MemberService } from './member.service';
import { CardStoreService } from './card-store.service';
import { MemberJwtStrategy } from './member-auth.guard';
import { AuthRateGuard } from './auth-rate.guard';
import { UploadIngressGuard } from './upload-ingress.guard';
import {
  CardCleanupController,
  MemberAdminController,
  MemberAuthController,
} from './member.controller';

@Module({
  imports: [JwtModule.register({})],
  providers: [
    MemberService,
    CardStoreService,
    MemberJwtStrategy,
    AuthRateGuard,
    UploadIngressGuard,
  ],
  controllers: [MemberAuthController, MemberAdminController, CardCleanupController],
  exports: [AuthRateGuard, UploadIngressGuard],
})
export class MemberModule {}
