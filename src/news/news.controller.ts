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
import { NewsService } from './news.service';
import { CreateNewsDto } from './dto/create-news.dto';
import { UpdateNewsDto } from './dto/update-news.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/v1/news')
@ApiTags('活动资讯')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'match_scorer', 'news_editor')
  @Post()
  @ApiOperation({ summary: '创建活动资讯' })
  create(@Body() createNewsDto: CreateNewsDto, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.newsService.create(createNewsDto, username);
  }

  @Get()
  @ApiOperation({ summary: '获取活动资讯列表' })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('category') category?: string,
  ) {
    return this.newsService.findAll(page, limit, category);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取单个活动资讯' })
  findOne(@Param('id') id: string) {
    return this.newsService.findOne(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'match_scorer', 'news_editor')
  @Patch(':id')
  @ApiOperation({ summary: '更新活动资讯' })
  update(@Param('id') id: string, @Body() updateNewsDto: UpdateNewsDto, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.newsService.update(id, updateNewsDto, username);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'match_scorer', 'news_editor')
  @Delete(':id')
  @ApiOperation({ summary: '删除活动资讯' })
  remove(@Param('id') id: string, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.newsService.remove(id, username);
  }
}
