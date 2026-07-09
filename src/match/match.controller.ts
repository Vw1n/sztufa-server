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
import { MatchService } from './match.service';
import { CreateMatchDto } from './dto/create-match.dto';
import { UpdateMatchDto } from './dto/update-match.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/v1/matches')
@ApiTags('比赛')
export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'match_scorer')
  @Post()
  @ApiOperation({ summary: '创建比赛' })
  create(@Body() createMatchDto: CreateMatchDto, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.matchService.create(createMatchDto, username);
  }

  @Get()
  @ApiOperation({ summary: '获取比赛列表' })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('teamId') teamId?: string,
    @Query('seasonId') seasonId?: string,
  ) {
    return this.matchService.findAll(page, limit, teamId, seasonId);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取单个比赛' })
  findOne(@Param('id') id: string) {
    return this.matchService.findOne(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'match_scorer')
  @Patch(':id')
  @ApiOperation({ summary: '更新比赛信息' })
  update(@Param('id') id: string, @Body() updateMatchDto: UpdateMatchDto, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.matchService.update(id, updateMatchDto, username);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'match_scorer')
  @Delete(':id')
  @ApiOperation({ summary: '删除比赛' })
  remove(@Param('id') id: string, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.matchService.remove(id, username);
  }
}
