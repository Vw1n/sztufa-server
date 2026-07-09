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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PlayerService } from './player.service';
import { CreatePlayerDto } from './dto/create-player.dto';
import { UpdatePlayerDto } from './dto/update-player.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

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

  @Get()
  @ApiOperation({ summary: '获取球员列表' })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('teamId') teamId?: string,
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

  @Get(':id/career')
  @ApiOperation({ summary: '获取球员跨赛季生涯数据' })
  getCareer(@Param('id') id: string) {
    return this.playerService.getCareerStats(id);
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
