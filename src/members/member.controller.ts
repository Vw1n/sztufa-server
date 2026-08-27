import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  UnauthorizedException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import multer from 'multer';
import { timingSafeEqual } from 'crypto';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { LoginDto } from '../auth/dto/login.dto';
import { ResetPasswordDto } from '../auth/dto/reset-password.dto';
import { MemberService } from './member.service';
import { MemberAuthGuard } from './member-auth.guard';
import { AuthRateGuard } from './auth-rate.guard';
import { UploadIngressGuard } from './upload-ingress.guard';
import {
  CardSubmissionDto,
  MemberListDto,
  MemberRegisterDto,
  MemberStatusDto,
  ReviewCardDto,
} from './member.dto';

const cardUpload = () =>
  FileInterceptor('campusCard', {
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 8, fieldSize: 1024, parts: 10 },
  });

@Controller('api/v1/member-auth')
export class MemberAuthController {
  constructor(private readonly members: MemberService) {}
  @Post('register')
  @UseGuards(UploadIngressGuard, AuthRateGuard)
  @UseInterceptors(cardUpload())
  register(@Body() dto: MemberRegisterDto, @UploadedFile() file: Express.Multer.File) {
    return this.members.register(dto, file);
  }
  @Post('login')
  @UseGuards(AuthRateGuard)
  login(@Body() dto: LoginDto) {
    return this.members.login(dto.username, dto.password);
  }
  @Get('me')
  @UseGuards(MemberAuthGuard)
  me(@Req() req: any) {
    return req.user;
  }
  @Post('logout')
  @UseGuards(MemberAuthGuard)
  logout(@Req() req: any) {
    return this.members.logout(req.user.id);
  }
  @Post('campus-card')
  @UseGuards(UploadIngressGuard, MemberAuthGuard, AuthRateGuard)
  @UseInterceptors(cardUpload())
  resubmit(
    @Req() req: any,
    @Body() dto: CardSubmissionDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.members.resubmit(req.user.id, dto, file);
  }
}

@Controller('api/v1/admin/members')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('super_admin')
export class MemberAdminController {
  constructor(private readonly members: MemberService) {}
  @Get() list(@Query() query: MemberListDto) {
    return this.members.list(query);
  }
  @Get(':id') detail(@Param('id') id: string, @Req() req: any) {
    return this.members.detail(id, req.user.username);
  }
  @Get(':id/cards/:assetId')
  async preview(
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const image = await this.members.preview(id, assetId, req.user.username);
    res
      .set({
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(image);
  }
  @Patch(':id/review') review(
    @Param('id') id: string,
    @Body() dto: ReviewCardDto,
    @Req() req: any,
  ) {
    const clientIp = typeof req.ip === 'string' && req.ip.trim() ? req.ip.trim() : '未知来源';
    return this.members.review(id, dto, req.user.username, clientIp);
  }
  @Patch(':id/status') status(
    @Param('id') id: string,
    @Body() dto: MemberStatusDto,
    @Req() req: any,
  ) {
    const clientIp = typeof req.ip === 'string' && req.ip.trim() ? req.ip.trim() : '未知来源';
    return this.members.setDisabled(id, dto.disabled, req.user.username, clientIp);
  }
  @Patch(':id/reset-password')
  @UseGuards(AuthRateGuard)
  reset(@Param('id') id: string, @Body() dto: ResetPasswordDto, @Req() req: any) {
    const clientIp = typeof req.ip === 'string' && req.ip.trim() ? req.ip.trim() : '未知来源';
    return this.members.resetPassword(id, dto.password, req.user.username, clientIp);
  }
}

@Controller('api/v1/internal/campus-card-cleanup')
export class CardCleanupController {
  constructor(private readonly members: MemberService) {}
  @Get()
  async cleanup(@Req() req: any) {
    const expected = process.env.CRON_SECRET
      ? Buffer.from(`Bearer ${process.env.CRON_SECRET}`)
      : null;
    const actual = Buffer.from(req.headers.authorization || '');
    if (!expected || actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new UnauthorizedException();
    return this.members.cleanup();
  }
}
