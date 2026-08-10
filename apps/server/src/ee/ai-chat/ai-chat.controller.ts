import { badRequest } from '../../common/errors/app-error';
import { ResolvePlanDto } from './dto/resolve-plan.dto';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';
import {
  AUTH_THROTTLER,
  EXPORT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { AiChatService } from './ai-chat.service';

@SkipThrottle({ [AUTH_THROTTLER]: true, [EXPORT_THROTTLER]: true })
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
@Controller('ai/chats')
export class AiChatController {
  constructor(private readonly aiChatService: AiChatService) {}

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async createChat(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiChatService.createChat(user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/')
  async listChats(
    @Body() body: { limit?: number; cursor?: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiChatService.listChats(user.id, workspace.id, body);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async getChatInfo(
    @Body() body: { chatId: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiChatService.getChatInfo(body.chatId, user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async deleteChat(
    @Body() body: { chatId: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.aiChatService.deleteChat(body.chatId, user.id, workspace.id);
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateChatTitle(
    @Body() body: { chatId: string; title: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.aiChatService.updateChatTitle(
      body.chatId,
      body.title,
      user.id,
      workspace.id,
    );
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('search')
  async searchChats(
    @Body() body: { query: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiChatService.searchChats(body.query, user.id, workspace.id);
  }

  @Post('send')
  async sendMessage(
    @Body()
    body: {
      chatId?: string;
      content: string;
      mentionedPageIds?: string[];
      contextPageId?: string;
      attachmentIds?: string[];
    },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: Response,
  ) {
    const raw = (res as any).raw || res;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    if (typeof raw.flushHeaders === 'function') {
      raw.flushHeaders();
    }

    try {
      for await (const event of this.aiChatService.sendMessage(
        body,
        user,
        workspace.id,
      )) {
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      raw.write('data: [DONE]\n\n');
    } catch (error: any) {
      console.error('[AiChatController] Error sending chat message:', error);
      const message = error?.message || 'An error occurred';
      const code = error?.status || error?.statusCode;
      raw.write(
        `data: ${JSON.stringify({
          type: 'error',
          message,
          code: code ? String(code) : undefined,
          retryable: false,
        })}\n\n`,
      );
      raw.write('data: [DONE]\n\n');
    } finally {
      raw.end();
    }
  }

  /**
   * Вложения в чате ИИ не поддерживаются.
   *
   * Маршрут возвращал пустое вложение с видом успеха: интерфейс показывал
   * файл прикрепленным, а к модели не уходило ничего и нигде ничего не
   * сохранялось. Молчаливая потеря файла хуже отказа, поэтому здесь отказ.
   *
   * Маршрут не убран, потому что его вызывает поле ввода чата: убрать его
   * значило бы отдать клиенту 404 без объяснения. Когда вложения будут
   * сделаны по-настоящему, отказ заменится реализацией.
   */
  @HttpCode(HttpStatus.OK)
  @Post('upload')
  async uploadFile() {
    throw badRequest('error.ai_chat.attachments_not_supported');
  }

  /**
   * Решение человека по плану необратимых действий.
   *
   * Отклонение это такое же явное действие, как подтверждение: молчаливого
   * устаревания плана нет, он либо исполнен, либо отклонен, и то и другое
   * записано на сообщении.
   */
  @HttpCode(HttpStatus.OK)
  @Post('resolve-plan')
  async resolvePlan(
    @Body() dto: ResolvePlanDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiChatService.resolvePlan(
      dto.messageId,
      dto.decision,
      user,
      workspace.id,
    );
  }
}
