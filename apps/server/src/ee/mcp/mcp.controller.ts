import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';
import {
  AUTH_THROTTLER,
  EXPORT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User, Workspace } from '@tessera/db/types/entity.types';
import { McpService } from './mcp.service';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { forbidden } from '../../common/errors/app-error';

@Controller(['mcp', 'api/mcp'])
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getInfo() {
    return {
      status: 'active',
      name: 'Tessera MCP Server (Model Context Protocol)',
      version: '1.0.0',
      description:
        'Connect any AI Agent (Claude Desktop, Antigravity, Cursor, etc.) to read and create pages in your Tessera wiki.',
      endpoint: '/mcp',
      authentication: 'Bearer <API_KEY>',
    };
  }

  @Post()
  @SkipThrottle({ [AUTH_THROTTLER]: true, [EXPORT_THROTTLER]: true })
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @SkipTransform()
  async handleMcpRpc(
    @Body() body: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!workspace?.settings?.['ai']?.mcp) {
      throw forbidden('error.mcp.mcp_is_disabled_for_this_workspace');
    }
    return this.mcpService.handleRpcRequest(body, user, workspace);
  }
}
