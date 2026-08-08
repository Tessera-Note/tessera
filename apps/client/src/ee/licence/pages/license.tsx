import { Divider, Text } from "@mantine/core";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import InstallationDetails from "@/ee/licence/components/installation-details.tsx";
import OssDetails from "@/ee/licence/components/oss-details.tsx";
import { getAppName } from "@/lib/config.ts";

export default function License() {
  const { t } = useTranslation();

  return (
    <>
      <Helmet>
        <title>
          {t("License")} - {getAppName()}
        </title>
      </Helmet>

      <SettingsTitle title={t("License")} />

      <InstallationDetails />

      <Divider my="lg" />

      <Text size="sm" c="dimmed" mb="md">
        {t(
          "This instance is operated in house and does not contact an external license service.",
        )}
      </Text>

      <OssDetails />
    </>
  );
}
