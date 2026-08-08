import { Menu, ActionIcon, Text } from "@mantine/core";
import React from "react";
import {
  IconDots,
  IconTrash,
  IconUserOff,
  IconUserCheck,
  IconShieldOff,
  IconUnlink,
} from "@tabler/icons-react";
import { modals } from "@mantine/modals";
import {
  useDeleteWorkspaceMemberMutation,
  useDeactivateWorkspaceMemberMutation,
  useActivateWorkspaceMemberMutation,
} from "@/features/workspace/queries/workspace-query.ts";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";
import { notifications } from "@mantine/notifications";
import { resetUserMfa } from "@/ee/mfa";
import { unlinkSsoAccount } from "@/ee/security/services/security-service.ts";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";

interface Props {
  userId: string;
  name: string;
  deactivatedAt: Date | null;
}
export default function MemberActionMenu({
  userId,
  name,
  deactivatedAt,
}: Props) {
  const { t } = useTranslation();
  const deleteWorkspaceMemberMutation = useDeleteWorkspaceMemberMutation();
  const deactivateMutation = useDeactivateWorkspaceMemberMutation();
  const activateMutation = useActivateWorkspaceMemberMutation();
  const { isAdmin } = useUserRole();
  const hasMfaFeature = useHasFeature(Feature.MFA);
  const hasSsoFeature = useHasFeature(Feature.SSO_CUSTOM);

  const isDeactivated = !!deactivatedAt;

  /**
   * Сброс снимает второй фактор и не включает его заново: новый секрет
   * заводит сам пользователь. При включенном принуждении он попадет
   * в принудительную настройку при следующем входе.
   */
  const onResetMfa = async () => {
    try {
      await resetUserMfa({ userId });
      notifications.show({
        message: t("Two-factor authentication has been reset"),
      });
    } catch (err) {
      notifications.show({
        color: "red",
        message:
          err?.response?.data?.message ??
          t("Failed to reset two-factor authentication"),
      });
    }
  };

  const openResetMfaModal = () =>
    modals.openConfirmModal({
      title: t("Reset two-factor authentication"),
      children: (
        <Text size="sm">
          {t(
            "This removes the second factor for this member. They will set it up again themselves, and will be notified by email.",
          )}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Reset"), cancel: t("Cancel") },
      confirmProps: { color: "orange" },
      onConfirm: onResetMfa,
    });

  /**
   * Снятие связи нужно, когда провайдер сменил идентификатор человека.
   * Вход в этом случае отвергается намеренно, и без снятия связи выхода нет.
   * Следующий вход заводит связь заново под текущим идентификатором.
   */
  const onUnlinkSso = async () => {
    try {
      const result = await unlinkSsoAccount({ userId });
      notifications.show({
        message: t("Sign-in provider link removed", {
          count: result.unlinked,
        }),
      });
    } catch (err) {
      notifications.show({
        color: "red",
        message:
          err?.response?.data?.message ??
          t("Failed to remove sign-in provider link"),
      });
    }
  };

  const openUnlinkSsoModal = () =>
    modals.openConfirmModal({
      title: t("Remove sign-in provider link"),
      children: (
        <Text size="sm">
          {t(
            "This unlinks this member from the identity provider. They will be linked again at their next sign-in through the provider, under the current identifier.",
          )}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Unlink"), cancel: t("Cancel") },
      confirmProps: { color: "orange" },
      onConfirm: onUnlinkSso,
    });

  const onDeactivate = async () => {
    await deactivateMutation.mutateAsync({ userId });
  };

  const onActivate = async () => {
    await activateMutation.mutateAsync({ userId });
  };

  const openDeactivateModal = () =>
    modals.openConfirmModal({
      title: isDeactivated ? t("Activate member") : t("Deactivate member"),
      children: (
        <Text size="sm">
          {isDeactivated
            ? t("Are you sure you want to activate this workspace member?")
            : t(
                "Are you sure you want to deactivate this workspace member? They will no longer be able to access this workspace.",
              )}
        </Text>
      ),
      centered: true,
      labels: {
        confirm: isDeactivated ? t("Activate") : t("Deactivate"),
        cancel: t("Cancel"),
      },
      confirmProps: { color: isDeactivated ? "blue" : "orange" },
      onConfirm: isDeactivated ? onActivate : onDeactivate,
    });

  const onRevoke = async () => {
    await deleteWorkspaceMemberMutation.mutateAsync({ userId });
  };

  const openRevokeModal = () =>
    modals.openConfirmModal({
      title: t("Delete member"),
      children: (
        <Text size="sm">
          {t(
            "Are you sure you want to delete this workspace member? This action is irreversible.",
          )}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Delete"), cancel: t("Don't") },
      confirmProps: { color: "red" },
      onConfirm: onRevoke,
    });

  return (
    <>
      <Menu
        shadow="xl"
        position="bottom-end"
        offset={20}
        width={200}
        withArrow
        arrowPosition="center"
      >
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            c="gray"
            aria-label={t("Member actions for {{name}}", { name })}
          >
            <IconDots size={20} stroke={2} />
          </ActionIcon>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Item
            onClick={openDeactivateModal}
            leftSection={
              isDeactivated ? (
                <IconUserCheck size={16} />
              ) : (
                <IconUserOff size={16} />
              )
            }
            disabled={!isAdmin}
          >
            {isDeactivated ? t("Activate member") : t("Deactivate member")}
          </Menu.Item>

          {hasMfaFeature && (
            <Menu.Item
              onClick={openResetMfaModal}
              leftSection={<IconShieldOff size={16} />}
              disabled={!isAdmin}
            >
              {t("Reset two-factor authentication")}
            </Menu.Item>
          )}

          {hasSsoFeature && (
            <Menu.Item
              onClick={openUnlinkSsoModal}
              leftSection={<IconUnlink size={16} />}
              disabled={!isAdmin}
            >
              {t("Remove sign-in provider link")}
            </Menu.Item>
          )}

          <Menu.Divider />

          <Menu.Item
            c="red"
            onClick={openRevokeModal}
            leftSection={<IconTrash size={16} />}
            disabled={!isAdmin}
          >
            {t("Delete member")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );
}
