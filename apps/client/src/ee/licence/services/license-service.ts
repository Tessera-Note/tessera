import api from "@/lib/api-client";
import { Entitlements } from "@/ee/entitlement/entitlement.types";

/**
 * Сведения о возможностях экземпляра.
 *
 * Внешнего поставщика лицензий нет, поэтому источник тот же, что и у остальных
 * проверок доступности возможностей: рабочее пространство отдает состав
 * включенных функций и уровень.
 */
export async function getLicenseInfo(): Promise<Entitlements> {
  const req = await api.post<Entitlements>("/workspace/entitlements");
  return req.data as Entitlements;
}
