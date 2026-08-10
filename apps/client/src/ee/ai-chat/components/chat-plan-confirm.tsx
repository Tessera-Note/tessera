import { useState } from "react";
import { Alert, Button, Group, List, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { resolveChatPlan } from "@/ee/ai-chat/services/ai-chat-service";
import { getApiErrorMessage } from "@/lib/api-error";

interface PlannedStep {
  tool: string;
  args?: Record<string, unknown>;
}

interface Props {
  messageId: string;
  steps: PlannedStep[];
}

/**
 * План необратимых действий, ожидающий решения человека.
 *
 * Агент не удаляет и не переносит сам: он записывает намерение, а человек
 * видит план целиком и решает. Отклонение здесь такое же явное действие, как
 * подтверждение: молчаливого устаревания нет, план либо исполнен, либо
 * отклонен, и то и другое записано на сообщении.
 *
 * План живет на сообщении, а не в памяти вкладки, поэтому переживает уход со
 * страницы: вернувшись позже, человек видит его же.
 */
export default function ChatPlanConfirm({ messageId, steps }: Props) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<"confirm" | "reject" | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const decide = async (decision: "confirm" | "reject") => {
    setPending(decision);
    try {
      const result = await resolveChatPlan({ messageId, decision });
      setOutcome(result.status);

      if (result.status === "failed") {
        const failedStep = result.results?.find((step) => !step.ok);
        notifications.show({
          color: "red",
          message: t("Stopped: {{reason}}", {
            reason: failedStep?.error ?? t("An error occurred"),
          }),
        });
        return;
      }

      notifications.show({
        message:
          result.status === "applied" ? t("Plan applied") : t("Plan rejected"),
      });
    } catch (err) {
      notifications.show({ message: getApiErrorMessage(err), color: "red" });
    } finally {
      setPending(null);
    }
  };

  if (outcome) {
    return (
      <Alert mt="sm" color={outcome === "applied" ? "green" : "gray"}>
        <Text size="sm">
          {outcome === "applied"
            ? t("Plan applied")
            : outcome === "rejected"
              ? t("Plan rejected")
              : t("The plan stopped partway. Nothing further was done.")}
        </Text>
      </Alert>
    );
  }

  return (
    <Alert mt="sm" color="orange" title={t("Confirm these changes")}>
      <Text size="sm">
        {t("These actions are not undone by editing. Review them first.")}
      </Text>

      <List size="sm" mt="xs">
        {steps.map((step, index) => (
          <List.Item key={index}>
            {step.tool}
            {step.args ? ` — ${JSON.stringify(step.args)}` : ""}
          </List.Item>
        ))}
      </List>

      <Group mt="md">
        <Button
          size="xs"
          color="red"
          loading={pending === "confirm"}
          disabled={pending !== null}
          onClick={() => decide("confirm")}
        >
          {t("Apply")}
        </Button>
        <Button
          size="xs"
          variant="default"
          loading={pending === "reject"}
          disabled={pending !== null}
          onClick={() => decide("reject")}
        >
          {t("Reject")}
        </Button>
      </Group>
    </Alert>
  );
}
