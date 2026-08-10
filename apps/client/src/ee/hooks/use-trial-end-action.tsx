import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { getBillingTrialDays, isCloud } from "@/lib/config.ts";
import APP_ROUTE from "@/lib/app-route.ts";
import useUserRole from "@/hooks/use-user-role.tsx";
import { notifications } from "@mantine/notifications";
import useTrial from "@/ee/hooks/use-trial.tsx";

export const useTrialEndAction = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const { isAdmin } = useUserRole();
  const { trialDaysLeft } = useTrial();

  useEffect(() => {
    if (isCloud() && trialDaysLeft === 0) {
      if (!pathname.startsWith("/settings")) {
        notifications.show({
          position: "top-right",
          color: "red",
          // Подстановка средствами языка не оставляет переводу ни ключа, ни
          // места для числа: оно идет через сам словарь.
          title: t("Your {{days}}-day trial has ended", {
            days: getBillingTrialDays(),
          }),
          message: t(
            "Please upgrade to a paid plan or contact your workspace admin.",
          ),
          autoClose: false,
        });

        // only admins can access the billing page
        if (isAdmin) {
          navigate(APP_ROUTE.SETTINGS.WORKSPACE.BILLING);
        } else {
          navigate(APP_ROUTE.SETTINGS.ACCOUNT.PROFILE);
        }
      }
    }
  }, [navigate]);
};
