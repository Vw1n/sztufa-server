import { MemberAuthGuard, OptionalMemberAuthGuard } from '../members/member-auth.guard';
import { Controller, Get, Put, Post, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PredictionService } from './prediction.service';
import { SubmitPredictionDto } from './dto/submit-prediction.dto';
import { PredictionListQueryDto } from './dto/prediction-list-query.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/v1/predictions')
@ApiTags('赛事竞猜')
export class PredictionController {
  constructor(private readonly predictionService: PredictionService) {}

  @UseGuards(OptionalMemberAuthGuard)
  @Get('matches')
  @ApiOperation({ summary: '获取可竞猜比赛列表' })
  @ApiQuery({ name: 'seasonId', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getMatches(@Query() query: PredictionListQueryDto, @Req() req: any) {
    const userId = req.user?.id;
    return this.predictionService.getMatchesForPrediction(
      userId,
      query.seasonId,
      query.page,
      query.limit,
    );
  }

  @UseGuards(OptionalMemberAuthGuard)
  @Get('matches/:matchId')
  @ApiOperation({ summary: '获取单场竞猜详情' })
  async getMatchDetail(@Param('matchId') matchId: string, @Req() req: any) {
    const userId = req.user?.id;
    return this.predictionService.getMatchPredictionDetail(matchId, userId);
  }

  @ApiBearerAuth()
  @UseGuards(MemberAuthGuard)
  @Put('matches/:matchId')
  @ApiOperation({ summary: '提交或修改竞猜选项' })
  async submitPrediction(
    @Param('matchId') matchId: string,
    @Body() dto: SubmitPredictionDto,
    @Req() req: any,
  ) {
    const userId = req.user.id;
    return this.predictionService.submitPrediction(userId, matchId, dto.choice);
  }

  @ApiBearerAuth()
  @UseGuards(MemberAuthGuard)
  @Get('me')
  @ApiOperation({ summary: '获取个人竞猜记录' })
  @ApiQuery({ name: 'seasonId', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getMyPredictions(@Query() query: PredictionListQueryDto, @Req() req: any) {
    const userId = req.user.id;
    return this.predictionService.getMyPredictions(userId, query.seasonId, query.page, query.limit);
  }

  @ApiBearerAuth()
  @UseGuards(MemberAuthGuard)
  @Get('me/stats')
  @ApiOperation({ summary: '获取个人竞猜统计' })
  @ApiQuery({ name: 'seasonId', required: false })
  async getMyStats(@Query('seasonId') seasonId: string, @Req() req: any) {
    const userId = req.user.id;
    return this.predictionService.getMyStats(userId, seasonId);
  }

  @UseGuards(OptionalMemberAuthGuard)
  @Get('leaderboard')
  @ApiOperation({ summary: '获取竞猜排行榜' })
  @ApiQuery({ name: 'scope', required: false, description: 'season | all' })
  @ApiQuery({ name: 'seasonId', required: false })
  async getLeaderboard(
    @Query('scope') scope: 'season' | 'all' = 'season',
    @Query('seasonId') seasonId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    return this.predictionService.getLeaderboard(scope, seasonId, userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'match_scorer')
  @Post('matches/:matchId/recalculate')
  @ApiOperation({ summary: '重新结算单场比赛竞猜（仅管理员/录分员）' })
  async recalculateMatch(@Param('matchId') matchId: string, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.predictionService.recalculateMatchPredictions(matchId, username);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'match_scorer')
  @Post('matches/:matchId/void')
  @ApiOperation({ summary: '作废单场比赛竞猜（超级管理员/录分员）' })
  async voidMatch(@Param('matchId') matchId: string, @Req() req: any) {
    const username = req.user?.username || 'admin';
    return this.predictionService.voidMatchPredictions(matchId, username);
  }
}
