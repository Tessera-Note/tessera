import { useState } from "react";
import {
  Button,
  Card,
  Group,
  Select,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useTranslation } from "react-i18next";
import { IGroup } from "@/features/group/types/group.types";
import {
  useAttachGroupDirectoryMutation,
  useDetachGroupDirectoryMutation,
} from "@/features/group/queries/group-query";
import { useGetSsoProviders } from "@/ee/security/queries/security-query";

interface Props {
  group: IGroup;
}

/**
 * Управление привязкой группы к каталогу.
 *
 * Синхронизация групп SSO распоряжается только теми группами, которые к
 * провайдеру привязаны явно, и сопоставляет их по ключу каталога, а не по
 * имени. Без этой формы привязку негде было завести, и возможность оставалась
 * недоступной из интерфейса.
 *
 * Группа под управлением SCIM здесь только показывается: ее ведет протокол
 * учетных записей, и отвязывать ее через этот экран нечем, иначе следующий
 * цикл каталога наткнулся бы на занятое имя.
 */
export default function GroupDirectoryPanel({ group }: Props) {
  const { t } = useTranslation();
  const { data: providers } = useGetSsoProviders();
  const attach = useAttachGroupDirectoryMutation();
  const detach = useDetachGroupDirectoryMutation();

  const [providerId, setProviderId] = useState<string | null>(null);
  const [directoryKey, setDirectoryKey] = useState("");

  const boundProvider = providers?.items?.find(
    (provider) => provider.id === group.directoryProviderId,
  );

  const openDetachModal = () =>
    modals.openConfirmModal({
      title: t("Return this group to manual management?"),
      children: (
        <Text size="sm">
          {t(
            "The directory will stop managing who belongs to this group. Current members stay as they are.",
          )}
        </Text>
      ),
      labels: { confirm: t("Detach"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => detach.mutate({ groupId: group.id }),
    });

  if (group.directorySource === "scim") {
    return (
      <Card withBorder radius="md" mt="md" padding="md">
        <Title order={5}>{t("Managed by the directory")}</Title>
        <Text size="sm" c="dimmed" mt="xs">
          {t(
            "This group comes from user provisioning. Its members are managed outside the wiki.",
          )}
        </Text>
      </Card>
    );
  }

  if (group.directorySource === "sso") {
    return (
      <Card withBorder radius="md" mt="md" padding="md">
        <Title order={5}>{t("Managed by the directory")}</Title>
        <Text size="sm" c="dimmed" mt="xs">
          {t("Provider")}: {boundProvider?.name ?? t("Unknown provider")}
        </Text>
        <Text size="sm" c="dimmed">
          {t("Directory key")}: {group.directoryKey}
        </Text>

        <Group mt="md">
          <Button
            variant="default"
            onClick={openDetachModal}
            loading={detach.isPending}
          >
            {t("Detach from directory")}
          </Button>
        </Group>
      </Card>
    );
  }

  // Привязывать не к чему, пока не заведен ни один провайдер входа.
  if (!providers?.items?.length) {
    return null;
  }

  return (
    <Card withBorder radius="md" mt="md" padding="md">
      <Title order={5}>{t("Let a directory manage this group")}</Title>
      <Text size="sm" c="dimmed" mt="xs">
        {t(
          "The directory will decide who belongs to this group on every sign-in. Members added here by hand will be removed.",
        )}
      </Text>

      <Select
        mt="md"
        label={t("Identity provider")}
        placeholder={t("Select a provider")}
        data={providers.items.map((provider) => ({
          value: provider.id,
          label: provider.name,
        }))}
        value={providerId}
        onChange={(value) => setProviderId(value)}
      />

      <TextInput
        mt="sm"
        label={t("Directory key")}
        description={t(
          "The value the provider sends in its groups claim. Leave empty to use the group name.",
        )}
        placeholder="CN=HR,OU=Groups,DC=example,DC=com"
        value={directoryKey}
        onChange={(event) => setDirectoryKey(event.currentTarget.value)}
      />

      <Group mt="md">
        <Button
          disabled={!providerId}
          loading={attach.isPending}
          onClick={() =>
            providerId &&
            attach.mutate({
              groupId: group.id,
              providerId,
              directoryKey: directoryKey.trim() || undefined,
            })
          }
        >
          {t("Attach to directory")}
        </Button>
      </Group>
    </Card>
  );
}
