import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Workspace } from '@tessera/db/types/entity.types';
import { Public } from '../../common/decorators/public.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { ScimAuthGuard } from './guards/scim-auth.guard';
import { ScimExceptionFilter } from './filters/scim-exception.filter';
import { ScimGroupService } from './services/scim-group.service';
import { ScimTokenContext } from './services/scim-user.service';
import { ScimToken } from './decorators/scim-token.decorator';
import { SCIM_BASE_PATH, SCIM_CONTENT_TYPE } from './scim.constants';

/**
 * Ресурс Group протокола SCIM.
 *
 * Устройство то же, что у ресурса User: `@Public()` снимает проверку сессии,
 * доступ дает `ScimAuthGuard` по токену, `@SkipTransform()` не дает обернуть
 * тело в конверт приложения, а тип ответа обязателен по RFC 7644 3.1.
 */
@UseFilters(ScimExceptionFilter)
@UseGuards(ScimAuthGuard)
@Controller(`${SCIM_BASE_PATH}/Groups`)
export class ScimGroupController {
  constructor(private readonly scimGroupService: ScimGroupService) {}

  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @Get()
  list(
    @AuthWorkspace() workspace: Workspace,
    @Query()
    query: {
      filter?: string;
      startIndex?: string;
      count?: string;
      excludedAttributes?: string;
    },
  ) {
    return this.scimGroupService.list(workspace, query);
  }

  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @Get(':id')
  find(
    @AuthWorkspace() workspace: Workspace,
    @Param('id') id: string,
    @Query('excludedAttributes') excludedAttributes?: string,
  ) {
    // Разбор параметра лежит в сервисе, чтобы список и чтение одной записи
    // понимали его одинаково: поиск подстроки здесь скрывал бы состав и на
    // `excludedAttributes=membersCount`, а список при том же значении нет.
    return this.scimGroupService.find(id, workspace, excludedAttributes);
  }

  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @HttpCode(HttpStatus.CREATED)
  @Post()
  create(
    @AuthWorkspace() workspace: Workspace,
    @ScimToken() token: ScimTokenContext,
    @Body() payload: any,
  ) {
    return this.scimGroupService.create(payload, workspace, token);
  }

  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @Put(':id')
  replace(
    @AuthWorkspace() workspace: Workspace,
    @ScimToken() token: ScimTokenContext,
    @Param('id') id: string,
    @Body() payload: any,
  ) {
    return this.scimGroupService.replace(id, payload, workspace, token);
  }

  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @Patch(':id')
  patch(
    @AuthWorkspace() workspace: Workspace,
    @ScimToken() token: ScimTokenContext,
    @Param('id') id: string,
    @Body() payload: any,
  ) {
    return this.scimGroupService.patch(id, payload, workspace, token);
  }

  /**
   * Удаление группы жесткое, поэтому ответ 204 без тела. Каскад уносит
   * членство и выданные через группу права на пространства и страницы.
   */
  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@AuthWorkspace() workspace: Workspace, @Param('id') id: string) {
    return this.scimGroupService.remove(id, workspace);
  }
}
