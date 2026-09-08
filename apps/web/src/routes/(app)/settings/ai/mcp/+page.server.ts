import { error } from '@sveltejs/kit';
import { ApiError } from '$lib/api/client';
import { listMcpTools } from '$lib/features/ai/services/mcp';
import { workspaceSettings } from '$lib/features/workspace/services/settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ fetch, request }) => {
  const cookie = request.headers.get('cookie');
  const headers = cookie ? { cookie } : undefined;

  try {
    const settings = await workspaceSettings(fetch, headers);
    // Перечень инструментов спрашивается только у включённого канала:
    // выключенный отвечает отказом, и это не повод не показывать экран.
    const tools = settings.mcpEnabled ? await listMcpTools(fetch, headers).catch(() => []) : [];
    return { settings, tools };
  } catch (failure) {
    if (failure instanceof ApiError) {
      error(failure.status, { message: failure.message, code: failure.code });
    }
    throw failure;
  }
};
