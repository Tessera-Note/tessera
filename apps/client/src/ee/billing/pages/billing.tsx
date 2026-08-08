import { Helmet } from "react-helmet-async";
import { Error404 } from "@/components/ui/error-404.tsx";
import { getAppName } from "@/lib/config.ts";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import BillingPlans from "@/ee/billing/components/billing-plans.tsx";
import BillingTrial from "@/ee/billing/components/billing-trial.tsx";
import ManageBilling from "@/ee/billing/components/manage-billing.tsx";
import { Divider } from "@mantine/core";
import React from "react";
import BillingDetails from "@/ee/billing/components/billing-details.tsx";
import { useBillingQuery } from "@/ee/billing/queries/billing-query.ts";
import useUserRole from "@/hooks/use-user-role.tsx";

export default function Billing() {
  const { data: billing, isError: isBillingError } = useBillingQuery();
  const { isAdmin } = useUserRole();

  // Отказ показывается заглушкой, а не пустотой: белый экран неотличим
  // от поломки. Пункт в боковой панели скрыт той же ролью, поэтому сюда
  // попадают только по прямой ссылке.
  if (!isAdmin) {
    return <Error404 />;
  }

  return (
    <>
      <Helmet>
        <title>Billing - {getAppName()}</title>
      </Helmet>
      <SettingsTitle title="Billing" />

      <BillingTrial />
      <BillingDetails />

      {isBillingError && <BillingPlans />}

      {billing && (
        <>
          <Divider my="lg" />
          <ManageBilling />
        </>
      )}
    </>
  );
}
