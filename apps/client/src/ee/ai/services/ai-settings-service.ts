import api from "@/lib/api-client.ts";
import {
  AiConnectionTest,
  AiModelOption,
  AiSettings,
  ListAiModelsDto,
  UpdateAiSettingsDto,
} from "@/ee/ai/types/ai-settings.types.ts";

export async function getAiSettings(): Promise<AiSettings> {
  const req = await api.post<AiSettings>("/ai/settings");
  return req.data;
}

export async function updateAiSettings(
  data: UpdateAiSettingsDto,
): Promise<AiSettings> {
  const req = await api.post<AiSettings>("/ai/settings/update", data);
  return req.data;
}

export async function resetAiSettings(): Promise<AiSettings> {
  const req = await api.post<AiSettings>("/ai/settings/reset");
  return req.data;
}

export async function listAiModels(
  data: ListAiModelsDto,
): Promise<{ models: AiModelOption[] }> {
  const req = await api.post<{ models: AiModelOption[] }>(
    "/ai/settings/models",
    data,
  );
  return req.data;
}

export async function testAiConnection(): Promise<AiConnectionTest> {
  const req = await api.post<AiConnectionTest>("/ai/settings/test");
  return req.data;
}
