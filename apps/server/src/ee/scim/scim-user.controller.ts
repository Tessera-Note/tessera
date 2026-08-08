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
import {
  ScimTokenContext,
  ScimUserService,
} from './services/scim-user.service';
import { ScimToken } from './decorators/scim-token.decorator';
import { SCIM_BASE_PATH, SCIM_CONTENT_TYPE } from './scim.constants';

/**
 * Ресурс User протокола SCIM.
 *
 * `@Public()` снимает проверку сессии, но не проверку доступа: аутентификация
 * идет по токену в `ScimAuthGuard`, а он же требует включенной синхронизации
 * в пространстве. `@SkipTransform()` обязателен: тела заданы спецификацией и
 * не переживут оборачивания в конверт приложения.
 *
 * Рабочее пространство берется из pre-handler по домену, как и во всем
 * приложении, и совпадает с тем, в границах которого guard нашел токен.
 *
 * Тип ответа `application/scim+json` обязателен по RFC 7644 3.1 и ставится
 * на каждом обработчике: обычный `application/json` часть провайдеров
 * считает ответом не по протоколу.
 */
@UseFilters(ScimExceptionFilter)
@UseGuards(ScimAuthGuard)
@Controller(`${SCIM_BASE_PATH}/Users`)
export class ScimUserController {
  constructor(private readonly scimUserService: ScimUserService) {}

  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @Get()
  list(
    @AuthWorkspace() workspace: Workspace,
    @Query() query: { filter?: string; startIndex?: string; count?: string },
  ) {
    return this.scimUserService.list(workspace, query);
  }

  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @Get(':id')
  find(@AuthWorkspace() workspace: Workspace, @Param('id') id: string) {
    return this.scimUserService.find(id, workspace);
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
    return this.scimUserService.create(payload, workspace, token);
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
    return this.scimUserService.replace(id, payload, workspace, token);
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
    return this.scimUserService.patch(id, payload, workspace, token);
  }

  /**
   * Удаление в протоколе означает у нас деактивацию, поэтому ответ 204 без
   * тела: провайдер получает подтверждение, а история авторства остается.
   */
  @Public()
  @SkipTransform()
  @Header('Content-Type', SCIM_CONTENT_TYPE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(
    @AuthWorkspace() workspace: Workspace,
    @ScimToken() token: ScimTokenContext,
    @Param('id') id: string,
  ) {
    return this.scimUserService.deactivate(id, workspace, token);
  }
}
