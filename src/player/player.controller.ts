import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PlayerService } from './player.service';
import { CreatePlayerDto } from './dto/create-player.dto';
import { UpdatePlayerDto } from './dto/update-player.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('api/v1/players')
@ApiTags('球员')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class PlayerController {
  constructor(private readonly playerService: PlayerService) {}

  @Post()
  @ApiOperation({ summary: '创建球员' })
  create(@Body() createPlayerDto: CreatePlayerDto) {
    return this.playerService.create(createPlayerDto);
  }

  @Get()
  @ApiOperation({ summary: '获取球员列表' })
  findAll(
    @Query('teamId') teamId?: string,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ) {
    return this.playerService.findAll(teamId, page, limit);
  }

  @Get('search')
  @ApiOperation({ summary: '按名称搜索球员' })
  search(@Query('name') name: string) {
    return this.playerService.searchByName(name);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取单个球员' })
  findOne(@Param('id') id: string) {
    return this.playerService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新球员信息' })
  update(@Param('id') id: string, @Body() updatePlayerDto: UpdatePlayerDto) {
    return this.playerService.update(id, updatePlayerDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除球员' })
  remove(@Param('id') id: string) {
    return this.playerService.remove(id);
  }
}
