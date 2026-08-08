import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  getAuditLogs,
  getAuditRetention,
  updateAuditRetention,
} from "@/ee/audit/services/audit-service";
import { IAuditLog, IAuditLogParams } from "@/ee/audit/types/audit.types";
import { IPagination } from "@/lib/types";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";

/**
 * Признак `enabled` нужен потому, что проверка прав на экране стоит после
 * хуков: без него запрос уходит на сервер и тому, кому экран не покажут,
 * и возвращает 403 еще до отрисовки отказа.
 */
export function useAuditLogsQuery(
  params?: IAuditLogParams,
  enabled = true,
): UseQueryResult<IPagination<IAuditLog>, Error> {
  return useQuery({
    queryKey: ["audit-logs", params],
    queryFn: () => getAuditLogs(params),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useAuditRetentionQuery(enabled = true) {
  return useQuery({
    queryKey: ["audit-retention"],
    queryFn: () => getAuditRetention(),
    enabled,
  });
}

export function useUpdateAuditRetentionMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: (data: { auditRetentionDays: number }) =>
      updateAuditRetention(data),
    onSuccess: () => {
      notifications.show({ message: t("Audit retention updated") });
      queryClient.invalidateQueries({ queryKey: ["audit-retention"] });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}
