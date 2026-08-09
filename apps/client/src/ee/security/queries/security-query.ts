import i18n from "@/i18n.ts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  createSsoProvider,
  deleteSsoProvider,
  getSsoProviders,
  updateSsoProvider,
} from "@/ee/security/services/security-service.ts";
import { notifications } from "@mantine/notifications";
import { IAuthProvider } from "@/ee/security/types/security.types.ts";
import { IPagination } from "@/lib/types.ts";

export function useGetSsoProviders(): UseQueryResult<
  IPagination<IAuthProvider>,
  Error
> {
  return useQuery({
    queryKey: ["sso-providers"],
    queryFn: () => getSsoProviders(),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Предупреждение о расхождении APP_URL с адресом интерфейса.
 *
 * Сервер строит адреса протокола от APP_URL, а значения для копирования
 * в провайдера этот экран показывает от адреса открытой страницы. При
 * расхождении каждый вход будет отвергаться, и без предупреждения причину
 * пришлось бы искать в логах.
 */
type AppUrlMismatch = { appUrl: string; origin: string };

function showAppUrlMismatch(
  data: { appUrlMismatch?: AppUrlMismatch | null } | undefined,
) {
  const mismatch = data?.appUrlMismatch;
  if (!mismatch) return;

  notifications.show({
    // Постоянный идентификатор: уведомление не закрывается само, и без него
    // каждое сохранение формы добавляло бы еще одну несбрасываемую копию.
    id: "sso-app-url-mismatch",
    title: i18n.t("Check APP_URL"),
    message: i18n.t(
      "APP_URL on the server ({{appUrl}}) does not match the address this page is open at ({{origin}}). Sign-in through this provider will be rejected until they match. Update APP_URL in the server environment and restart, or open the app at that address.",
      { appUrl: mismatch.appUrl, origin: mismatch.origin },
    ),
    color: "yellow",
    autoClose: false,
  });
}

export function useCreateSsoProviderMutation() {
  const queryClient = useQueryClient();

  return useMutation<any, Error, Partial<IAuthProvider>>({
    mutationFn: (data: Partial<IAuthProvider>) => createSsoProvider(data),
    onSuccess: (data) => {
      showAppUrlMismatch(data);
      queryClient.invalidateQueries({
        queryKey: ["sso-providers"],
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useUpdateSsoProviderMutation() {
  const queryClient = useQueryClient();

  return useMutation<any, Error, Partial<IAuthProvider>>({
    mutationFn: (data: Partial<IAuthProvider>) => updateSsoProvider(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: "Updated successfully" });
      showAppUrlMismatch(data);
      queryClient.invalidateQueries({
        queryKey: ["sso-providers"],
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useDeleteSsoProviderMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (providerId: string) => deleteSsoProvider({ providerId }),
    onSuccess: (data, variables) => {
      notifications.show({ message: "Deleted successfully" });

      queryClient.invalidateQueries({
        queryKey: ["sso-providers"],
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}
