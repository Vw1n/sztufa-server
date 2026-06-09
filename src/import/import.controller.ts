import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ImportService } from './import.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('api/v1/import')
@ApiTags('数据导入')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post('json')
  @ApiOperation({ summary: '从JSON文件导入数据' })
  async importFromJson(@Body() body: { filePath: string }) {
    const result = await this.importService.importFromJson(body.filePath);
    return {
      message: '导入完成',
      result,
    };
  }
}
