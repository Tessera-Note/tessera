import { useAppVersion } from "@/features/workspace/queries/workspace-query.ts";
import { isCloud } from "@/lib/config.ts";
import classes from "@/components/settings/settings.module.css";
import { Indicator, Text, Tooltip } from "@mantine/core";
import React from "react";
import semverGt from "semver/functions/gt";
import { useTranslation } from "react-i18next";
import { getReleasesUrl } from "@/lib/config.ts";

export default function AppVersion() {
  const { t } = useTranslation();
  const { data: appVersion } = useAppVersion(!isCloud());
  // Адрес выпусков приходит с сервера, при его отсутствии берется адрес хаба.
  const releasesUrl = appVersion?.releaseUrl || getReleasesUrl();
  let hasUpdate = false;
  try {
    hasUpdate =
      appVersion &&
      parseFloat(appVersion.latestVersion) > 0 &&
      semverGt(appVersion.latestVersion, appVersion.currentVersion);
  } catch (err) {
    console.error(err);
  }

  return (
    <div className={classes.text}>
      <Tooltip
        label={t("{{latestVersion}} is available", {
          latestVersion: `v${appVersion?.latestVersion}`,
        })}
        disabled={!hasUpdate}
      >
        <Indicator
          label={t("New update")}
          color="gray"
          inline
          size={16}
          position="middle-end"
          style={{ cursor: "pointer" }}
          disabled={!hasUpdate}
          onClick={() => {
            window.open(releasesUrl, "_blank");
          }}
        >
          <Text
            size="sm"
            c="dimmed"
            component="a"
            mr={45}
            href={releasesUrl}
            target="_blank"
          >
            {appVersion?.currentVersion && <>v{appVersion?.currentVersion}</>}
          </Text>
        </Indicator>
      </Tooltip>
    </div>
  );
}
