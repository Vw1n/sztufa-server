import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { RegistrationService, UserContext } from './registration.service';
import { CreateRegistrationDto } from './dto/create-registration.dto';
import { SaveRegistrationDto } from './dto/save-registration.dto';
import { SubmitRegistrationDto } from './dto/submit-registration.dto';
import { ReviewRegistrationDto } from './dto/review-registration.dto';
import { RegistrationListQueryDto } from './dto/registration-list-query.dto';

@ApiTags('赛季报名管理')
@ApiBearerAuth()
@Controller('api/v1/registrations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RegistrationController {
  constructor(private readonly registrationService: RegistrationService) {}

  @Get('me')
  @Roles('coach')
  @ApiOperation({ summary: '领队获取当前绑定球队的报名记录' })
  async getMine(@Query('seasonId') seasonId: string, @Request() req: { user: UserContext }) {
    return this.registrationService.getMine(seasonId, req.user);
  }

  @Post()
  @Roles('coach')
  @ApiOperation({ summary: '领队创建或返回当前赛季球队草稿' })
  async create(@Body() dto: CreateRegistrationDto, @Request() req: { user: UserContext }) {
    return this.registrationService.create(dto, req.user);
  }

  @Get('admin')
  @Roles('super_admin')
  @ApiOperation({ summary: '管理员获取所有球队报名摘要列表' })
  async getAdminList(@Query() query: RegistrationListQueryDto) {
    return this.registrationService.getAdminList(query);
  }

  @Get(':id')
  @Roles('coach', 'super_admin')
  @ApiOperation({ summary: '获取单份报名详情' })
  async getDetail(@Param('id') id: string, @Request() req: { user: UserContext }) {
    return this.registrationService.getDetail(id, req.user);
  }

  @Patch(':id')
  @Roles('coach')
  @ApiOperation({ summary: '领队保存草稿或退回重新修改的资料和球员名单' })
  async save(
    @Param('id') id: string,
    @Body() dto: SaveRegistrationDto,
    @Request() req: { user: UserContext },
  ) {
    return this.registrationService.save(id, dto, req.user);
  }

  @Post(':id/submit')
  @Roles('coach')
  @ApiOperation({ summary: '领队提交或重新提交报名' })
  async submit(
    @Param('id') id: string,
    @Body() _dto: SubmitRegistrationDto,
    @Request() req: { user: UserContext },
  ) {
    return this.registrationService.submit(id, req.user);
  }

  @Post(':id/approve')
  @Roles('super_admin')
  @ApiOperation({ summary: '管理员审核通过并物化正式赛季数据' })
  async approve(
    @Param('id') id: string,
    @Body() dto: ReviewRegistrationDto,
    @Request() req: { user: UserContext },
  ) {
    return this.registrationService.approve(id, dto, req.user);
  }

  @Post(':id/request-changes')
  @Roles('super_admin')
  @ApiOperation({ summary: '管理员退回修改并写入审核意见' })
  async requestChanges(
    @Param('id') id: string,
    @Body() dto: ReviewRegistrationDto,
    @Request() req: { user: UserContext },
  ) {
    return this.registrationService.requestChanges(id, dto, req.user);
  }
}
