import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { FormDraftService } from './form-draft.service';
import { SaveFormDraftDto } from './dto/save-form-draft.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('api/v1/admin/form-drafts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('super_admin')
export class FormDraftController {
  constructor(private readonly formDraftService: FormDraftService) {}

  @Post()
  async saveDraft(@Body() dto: SaveFormDraftDto, @Request() req: any) {
    const username = req.user?.username || 'admin';
    return this.formDraftService.saveDraft(dto, username);
  }

  @Patch(':id')
  async updateDraft(@Param('id') id: string, @Body() dto: SaveFormDraftDto, @Request() req: any) {
    const username = req.user?.username || 'admin';
    return this.formDraftService.saveDraft(dto, username, id);
  }

  @Get(':id')
  async getDraft(@Param('id') id: string) {
    return this.formDraftService.getDraft(id);
  }

  @Get()
  async listDrafts(@Query('formType') formType?: string) {
    return this.formDraftService.listDrafts(formType);
  }

  @Delete(':id')
  async deleteDraft(@Param('id') id: string, @Request() req: any) {
    const username = req.user?.username || 'admin';
    return this.formDraftService.deleteDraft(id, username, req.user);
  }

  @Post(':id/materialize')
  async materializeDraft(@Param('id') id: string, @Request() req: any) {
    const username = req.user?.username || 'admin';
    return this.formDraftService.tryMaterialize(id, username);
  }
}
