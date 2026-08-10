import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';
import {
  AUTH_THROTTLER,
  AI_CHAT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { Public } from '../../common/decorators/public.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { PdfExportService } from './pdf-export.service';
import {
  ExportPagePdfDto,
  PdfDownloadDto,
  PdfRenderDto,
} from './dto/pdf-export.dto';
import { sanitizeFileName } from '../../common/helpers/utils';

@Controller('pdf-export')
export class PdfExportController {
  constructor(private readonly pdfExportService: PdfExportService) {}

  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @Post('page')
  async exportPage(
    @Body() dto: ExportPagePdfDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pdfExportService.createExportTask({
      pageId: dto.pageId,
      includeChildren: dto.includeChildren ?? false,
      user,
      workspace,
    });
  }

  /**
   * Called by the headless browser, which has no session — the render token is
   * the credential, and it only unlocks the one page it was minted for.
   */
  // Маршрут публичный и принимает токен отрисовки, то есть перебор токена
  // ничем не ограничен. Глобального лимита на этот префикс нет, ограничитель
  // ставится маршруту. Пользователя здесь нет, и счетчик ведется по адресу:
  // `UserThrottlerGuard` в этом случае откатывается к базовому определению.
  @Public()
  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @UseGuards(UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @Post('render')
  async render(@Body() dto: PdfRenderDto) {
    // Returned bare: the global interceptor already wraps responses in `data`,
    // and wrapping again here put the payload at data.data.pages.
    return this.pdfExportService.getRenderData(dto.token);
  }

  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @Post('download')
  async download(
    @Body() dto: PdfDownloadDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    const file = await this.pdfExportService.getDownload(
      dto.fileTaskId,
      user,
      workspace,
    );

    res.headers({
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        'attachment; filename="' +
        encodeURIComponent(
          sanitizeFileName(file.fileName, { preserveSpaces: true }),
        ) +
        '"',
    });

    res.send(file.stream);
  }
}
