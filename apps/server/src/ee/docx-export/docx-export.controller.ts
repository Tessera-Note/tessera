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
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User } from '@tessera/db/types/entity.types';
import { DocxExportService } from './docx-export.service';
import { ExportPageDocxDto } from './dto/docx-export.dto';
import { sanitizeFileName } from '../../common/helpers/utils';

/**
 * Выгрузка страницы в Word.
 *
 * Ограничение частоты стоит по тому же образцу, что у экспорта PDF: сборка
 * документа идет в процессе приложения и упирается в процессор, поэтому под
 * глобальный лимит ее оставлять нельзя.
 */
@Controller('docx-export')
export class DocxExportController {
  constructor(private readonly docxExportService: DocxExportService) {}

  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @Post()
  async exportPage(
    @Body() dto: ExportPageDocxDto,
    @AuthUser() user: User,
    @Res() res: FastifyReply,
  ) {
    const file = await this.docxExportService.exportPage(dto.pageId, user);

    // Имя кодируется, потому что заголовок страницы может быть на любом языке,
    // а Content-Disposition ограничен латиницей. Клиент декодирует обратно.
    res.headers({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition':
        'attachment; filename="' +
        encodeURIComponent(
          sanitizeFileName(file.fileName, { preserveSpaces: true }),
        ) +
        '"',
    });

    res.send(file.buffer);
  }
}
