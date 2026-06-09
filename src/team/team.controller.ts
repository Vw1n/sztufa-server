import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TeamService } from './team.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('api/v1/teams')
@ApiTags('球队')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Post()
  @ApiOperation({ summary: '创建球队' })
  create(@Body() createTeamDto: CreateTeamDto) {
    return this.teamService.create(createTeamDto);
  }

  @Get()
  @ApiOperation({ summary: '获取球队列表' })
  findAll(@Query('page') page: number = 1, @Query('limit') limit: number = 10) {
    return this.teamService.findAll(page, limit);
  }

  @Get('search')
  @ApiOperation({ summary: '按名称搜索球队' })
  search(@Query('name') name: string) {
    return this.teamService.searchByName(name);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取单个球队' })
  findOne(@Param('id') id: string) {
    return this.teamService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新球队信息' })
  update(@Param('id') id: string, @Body() updateTeamDto: UpdateTeamDto) {
    return this.teamService.update(id, updateTeamDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除球队' })
  remove(@Param('id') id: string) {
    return this.teamService.remove(id);
  }
}
