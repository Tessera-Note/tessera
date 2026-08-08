import {
  useMutation,
  UseMutationResult,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  getAiSettings,
  listAiModels,
  resetAiSettings,
  testAiConnection,
  updateAiSettings,
} from "@/ee/ai/services/ai-settings-service.ts";
import {
  AiConnectionTest,
  AiModelOption,
  AiSettings,
  ListAiModelsDto,
  UpdateAiSettingsDto,
} from "@/ee/ai/types/ai-settings.types.ts";

const AI_SETTINGS_KEY = ["ai-settings"];

export function useAiSettingsQuery(): UseQueryResult<AiSettings, Error> {
  return useQuery({
    queryKey: AI_SETTINGS_KEY,
    queryFn: () => getAiSettings(),
    staleTime: 0,
  });
}

export function useUpdateAiSettingsMutation(): UseMutationResult<
  AiSettings,
  Error,
  UpdateAiSettingsDto
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data) => updateAiSettings(data),
    onSuccess: (data) => queryClient.setQueryData(AI_SETTINGS_KEY, data),
  });
}

export function useResetAiSettingsMutation(): UseMutationResult<
  AiSettings,
  Error,
  void
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => resetAiSettings(),
    onSuccess: (data) => queryClient.setQueryData(AI_SETTINGS_KEY, data),
  });
}

export function useListAiModelsMutation(): UseMutationResult<
  { models: AiModelOption[] },
  Error,
  ListAiModelsDto
> {
  return useMutation({
    mutationFn: (data) => listAiModels(data),
  });
}

export function useTestAiConnectionMutation(): UseMutationResult<
  AiConnectionTest,
  Error,
  void
> {
  return useMutation({
    mutationFn: () => testAiConnection(),
  });
}
