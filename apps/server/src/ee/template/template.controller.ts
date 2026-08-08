import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CreateTemplateDto,
  ListTemplatesDto,
  TemplateIdDto,
  UpdateTemplateDto,
  UseTemplateDto,
} from './dto/template.dto';
import { TemplateService } from './template.service';
import { WsService } from '../../ws/ws.service';

@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplateController {
  constructor(
    private readonly templateService: TemplateService,
    private readonly wsService: WsService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(
    @Body() dto: ListTemplatesDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.listTemplates(dto, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(
    @Body() dto: TemplateIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.getTemplate(dto.templateId, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreateTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.createTemplate(dto, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() dto: UpdateTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.updateTemplate(dto, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(
    @Body() dto: TemplateIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.deleteTemplate(dto.templateId, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('use')
  async use(
    @Body() dto: UseTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.templateService.useTemplate(dto, user, workspace);
    await this.wsService.emitTreeRefresh(page.spaceId, page.id);
    return page;
  }
}
