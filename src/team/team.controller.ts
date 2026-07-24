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
import { TeamService } from './team.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { CreateTeamWithPlayersDto } from './dto/create-team-with-players.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { UpdateTeamWithPlayersDto } from './dto/update-team-with-players.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TeamQueryService } from './team-query.service';
import { TeamRosterService } from './team-roster.service';

@Controller('api/v1/teams')
@ApiTags('球队')
export class TeamController {
  constructor(
    private readonly teamService: TeamService,
    private readonly teamQueryService: TeamQueryService,
    private readonly teamRosterService: TeamRosterService,
  ) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'coach')
  @Post('with-players')
  @ApiOperation({ summary: '在单个事务中创建球队及全部球员' })
  createWithPlayers(@Body() dto: CreateTeamWithPlayersDto, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.teamService.createWithPlayers(dto, username);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post()
  @ApiOperation({ summary: '创建球队' })
  create(@Body() createTeamDto: CreateTeamDto, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.teamService.create(createTeamDto, username);
  }

  @Get()
  @ApiOperation({ summary: '获取球队列表' })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('seasonId') seasonId?: string,
    @Query('gender') gender?: string,
  ) {
    return this.teamQueryService.findAll(page, limit, seasonId, gender);
  }

  @Get('search')
  @ApiOperation({ summary: '按名称搜索球队' })
  search(@Query('name') name: string) {
    return this.teamQueryService.searchByName(name);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取单个球队' })
  findOne(@Param('id') id: string) {
    return this.teamQueryService.findOne(id);
  }

  @Get(':id/players')
  @ApiOperation({ summary: '获取球队在特定赛季的球员名册' })
  getTeamRoster(@Param('id') id: string, @Query('seasonId') seasonId?: string) {
    return this.teamRosterService.getTeamRoster(id, seasonId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'coach')
  @Patch(':id/with-players')
  @ApiOperation({ summary: '在单个事务中更新球队信息及球员名单' })
  updateWithPlayers(
    @Param('id') id: string,
    @Body() dto: UpdateTeamWithPlayersDto,
    @Req() req: any,
  ) {
    const username = req.user?.username || 'admin';
    return this.teamService.updateWithPlayers(id, dto, username, req.user);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'coach')
  @Patch(':id')
  @ApiOperation({ summary: '更新球队信息' })
  update(@Param('id') id: string, @Body() updateTeamDto: UpdateTeamDto, @Req() req: any) {
    if (req.user.role === 'coach' && req.user.teamId !== id) {
      throw new ForbiddenException('您没有权限修改其他球队的信息');
    }
    const username = req.user?.username || 'admin';
    return this.teamService.update(id, updateTeamDto, username);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Delete(':id')
  @ApiOperation({ summary: '删除球队' })
  remove(@Param('id') id: string, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.teamService.remove(id, username);
  }
}
