import { Controller, Post, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ImportService } from './import.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import * as path from 'path';

@Controller('api/v1/import')
@ApiTags('数据导入')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('super_admin')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post('json')
  @ApiOperation({ summary: '从JSON文件导入数据' })
  async importFromJson(@Body() body: { filePath: string }) {
    if (!body.filePath) {
      throw new BadRequestException('文件路径不能为空');
    }
    const resolvedPath = path.resolve(body.filePath);
    const workspacePath = path.resolve(process.cwd());
    if (!resolvedPath.startsWith(workspacePath)) {
      throw new BadRequestException('非法的备份导入路径：仅允许导入项目目录范围内的文件');
    }

    const result = await this.importService.importFromJson(resolvedPath);
    return {
      message: '导入完成',
      result,
    };
  }
}
