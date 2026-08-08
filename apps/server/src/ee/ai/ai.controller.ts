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
import { AiService } from './ai.service';

@SkipThrottle({ [AUTH_THROTTLER]: true, [EXPORT_THROTTLER]: true })
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @HttpCode(HttpStatus.OK)
  @Post('generate')
  async generate(
    @Body() body: { action?: string; content: string; prompt?: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiService.generate({
      ...body,
      workspaceId: workspace.id,
      locale: user.locale,
    });
  }

  @Post('generate/stream')
  async generateStream(
    @Body() body: { action?: string; content: string; prompt?: string },
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
      for await (const chunk of this.aiService.generateStream({
        ...body,
        workspaceId: workspace.id,
        locale: user.locale,
      })) {
        raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      raw.write('data: [DONE]\n\n');
    } catch (error: any) {
      raw.write(
        `data: ${JSON.stringify({ error: error?.message || 'An error occurred' })}\n\n`,
      );
    } finally {
      raw.end();
    }
  }
}
