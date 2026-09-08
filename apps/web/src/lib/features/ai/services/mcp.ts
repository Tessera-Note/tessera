/**
 * Перечень инструментов канала MCP.
 *
 * Спрашивается у самого канала (`tools/list`), а не переписан сюда списком:
 * инструментов у сервера больше полусотни, они меняются, и второй их перечень
 * на клиенте разошёлся бы с первым молча — экран обещал бы модели то, чего
 * она не умеет, либо умалчивал бы о том, что умеет.
 *
 * Канал говорит по JSON-RPC, а не обычным ответом, поэтому запрос идёт мимо
 * общего слоя: тот разбирает `{code, message}`, а здесь ответ приходит в поле
 * `result` либо `error` того же успешного ответа.
 */

import { apiBase } from '$lib/api/base';
import { ApiError } from '$lib/api/client';

export type McpTool = { name: string; description: string };

/** Ответ JSON-RPC. Успех и отказ приходят одинаковым кодом. */
type Rpc = {
  result?: { tools?: { name?: string; description?: string }[] };
  error?: { code?: number; message?: string };
};

export async function listMcpTools(
  fetcher?: typeof fetch,
  headers?: Record<string, string>
): Promise<McpTool[]> {
  const call = fetcher ?? fetch;
  const response = await call(`${apiBase()}/api/mcp`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });

  if (!response.ok) {
    // Выключенный канал отвечает отказом, а не пустым перечнем: так решено на
    // сервере, и пустой перечень читался бы как «сервер сломан».
    const body = await response.text();
    let code = 'error.common.unknown';
    try {
      code = (JSON.parse(body) as { code?: string }).code ?? code;
    } catch {
      // Тело не разобралось: отвечает не наш сервер, а что-то на его месте.
    }
    throw new ApiError(response.status, code, '', {});
  }

  const body = (await response.json()) as Rpc;
  if (body.error) {
    throw new ApiError(500, 'error.mcp.disabled', body.error.message ?? '', {});
  }

  return (body.result?.tools ?? [])
    .filter((one): one is { name: string; description?: string } => Boolean(one?.name))
    .map((one) => ({ name: one.name, description: one.description ?? '' }));
}

/** Адрес канала для настройки внешнего клиента. */
export function mcpAddress(): string {
  if (typeof window === 'undefined') return '/mcp';
  return `${window.location.origin}/mcp`;
}
