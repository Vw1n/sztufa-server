import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PlayerService } from './player.service';
import { CreatePlayerDto } from './dto/create-player.dto';
import { UpdatePlayerDto } from './dto/update-player.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { toPublicPlayerDto } from '../common/dto/public-response.dto';

@Controller('api/v1/players')
@ApiTags('球员')
export class PlayerController {
  constructor(private readonly playerService: PlayerService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'coach')
  @Post()
  @ApiOperation({ summary: '创建球员' })
  create(@Body() createPlayerDto: CreatePlayerDto, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.playerService.create(createPlayerDto, username, req.user);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'coach')
  @Get('admin/manage')
  @ApiOperation({ summary: '管理端获取包含敏感信息的完整球员列表' })
  async findAdminAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('teamId') teamId?: string,
    @Req() req?: any,
  ) {
    let effectiveTeamId = teamId;
    if (req?.user?.role === 'coach') {
      if (!req.user.teamId) {
        throw new ForbiddenException('教练账号未绑定球队，无权访问管理数据');
      }
      effectiveTeamId = req.user.teamId;
    }
    return this.playerService.findAll(effectiveTeamId, page, limit);
  }

  @Get()
  @ApiOperation({ summary: '获取脱敏后的公共球员列表' })
  async findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('teamId') teamId?: string,
  ) {
    const result = await this.playerService.findPublicAll(teamId, page, limit);
    return {
      ...result,
      data: result.data.map(toPublicPlayerDto),
    };
  }

  @Get('search')
  @ApiOperation({ summary: '按名称搜索脱敏公共球员' })
  async search(@Query('name') name: string) {
    const list = await this.playerService.searchPublicByName(name);
    return list.map(toPublicPlayerDto);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取单个脱敏公共球员' })
  async findOne(@Param('id') id: string) {
    const player = await this.playerService.findPublicOne(id);
    return toPublicPlayerDto(player);
  }

  @Get(':id/career')
  @ApiOperation({ summary: '获取脱敏公共球员指定赛季球星卡数据' })
  async getCareer(@Param('id') id: string, @Query('seasonId') seasonId: string) {
    const result = await this.playerService.getCareerStats(id, seasonId);
    return {
      ...result,
      player: toPublicPlayerDto(result.player),
    };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'coach')
  @Patch(':id')
  @ApiOperation({ summary: '更新球员信息' })
  update(@Param('id') id: string, @Body() updatePlayerDto: UpdatePlayerDto, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.playerService.update(id, updatePlayerDto, username, req.user);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'coach')
  @Delete(':id')
  @ApiOperation({ summary: '删除球员' })
  remove(@Param('id') id: string, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.playerService.remove(id, username, req.user);
  }
}
