import 'reflect-metadata';
import { SKIP_TRANSFORM_KEY } from '../../common/decorators/skip-transform.decorator';
import { McpController } from './mcp.controller';

jest.mock('./mcp.service', () => ({
  McpService: class McpService {},
}));

describe('McpController', () => {
  it('returns JSON-RPC responses without the global HTTP envelope', () => {
    const handler = McpController.prototype.handleMcpRpc;

    expect(Reflect.getMetadata(SKIP_TRANSFORM_KEY, handler)).toBe(true);
  });

  describe('handleMcpRpc', () => {
    const user = { id: 'user-1' } as any;
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    const buildController = () => {
      const mcpService = {
        handleRpcRequest: jest.fn().mockResolvedValue({ ok: true }),
      };
      const controller = new McpController(mcpService as any);
      return { controller, mcpService };
    };

    it('rejects requests when settings.ai.mcp is disabled', async () => {
      const { controller, mcpService } = buildController();
      const workspace = { id: 'ws-1', settings: { ai: { mcp: false } } } as any;

      await expect(
        controller.handleMcpRpc(body, user, workspace),
      ).rejects.toThrow('MCP is disabled for this workspace');
      expect(mcpService.handleRpcRequest).not.toHaveBeenCalled();
    });

    it('rejects requests when the switch was never set', async () => {
      const { controller, mcpService } = buildController();
      const workspace = { id: 'ws-1', settings: {} } as any;

      await expect(
        controller.handleMcpRpc(body, user, workspace),
      ).rejects.toThrow('MCP is disabled for this workspace');
      expect(mcpService.handleRpcRequest).not.toHaveBeenCalled();
    });

    it('delegates to McpService when settings.ai.mcp is enabled', async () => {
      const { controller, mcpService } = buildController();
      const workspace = { id: 'ws-1', settings: { ai: { mcp: true } } } as any;

      await expect(
        controller.handleMcpRpc(body, user, workspace),
      ).resolves.toEqual({ ok: true });
      expect(mcpService.handleRpcRequest).toHaveBeenCalledWith(
        body,
        user,
        workspace,
      );
    });
  });
});
