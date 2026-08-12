import {
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconInfoCircle, IconRefresh } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAiSettingsQuery,
  useListAiModelsMutation,
  useResetAiSettingsMutation,
  useTestAiConnectionMutation,
  useUpdateAiSettingsMutation,
} from "@/ee/ai/queries/ai-settings-query.ts";
import {
  AiDriver,
  UpdateAiSettingsDto,
} from "@/ee/ai/types/ai-settings.types.ts";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";
import { useUpgradeLabel } from "@/ee/hooks/use-upgrade-label";
import { getApiErrorMessage } from "@/lib/api-error";

const DRIVER_OPTIONS: Array<{ value: AiDriver; label: string }> = [
  { value: "", label: "Use server environment (default)" },
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "gemini", label: "Google Gemini" },
  { value: "ollama", label: "Ollama (self-hosted)" },
  { value: "openai-compatible", label: "OpenAI-compatible endpoint" },
];

/** Providers where the base URL is derived and only worth showing as advanced. */
const BASE_URL_REQUIRED: AiDriver[] = ["openai-compatible", "ollama"];

/**
 * Провайдер эмбеддингов выбирается из того же списка, что и провайдер чата.
 * Пустое значение наследует выбор чата: у большинства рабочих пространств
 * провайдер один и тот же.
 */
const EMBEDDING_DRIVER_OPTIONS: Array<{ value: AiDriver; label: string }> = [
  { value: "", label: "Same as chat provider" },
  ...DRIVER_OPTIONS.filter((o) => o.value !== ""),
];
const SUPPORTS_MODEL_LISTING: AiDriver[] = [
  "openai",
  "openrouter",
  "openai-compatible",
  "gemini",
  "ollama",
];

/**
 * A plain text field named like a URL is exactly what browsers and password
 * managers autofill with an email or username. That value then becomes the API
 * host, so the fields opt out of autofill and the URL is validated inline.
 */
const NO_AUTOFILL = {
  autoComplete: "off",
  autoCorrect: "off",
  spellCheck: false,
  "data-form-type": "other",
  "data-lpignore": "true",
} as const;

/**
 * Возвращается ключ словаря, а не готовый текст: функция объявлена вне
 * компонента, где `t` недоступен, а строки видны пользователю и обязаны идти
 * через i18next. Перевод делают места вызова.
 */
function baseUrlErrorKey(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Must start with http:// or https://";
    }
    return null;
  } catch {
    return "Must be a full URL, e.g. https://openrouter.ai/api/v1";
  }
}

interface FormState {
  driver: AiDriver;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  completionModel: string;
  embeddingDriver: AiDriver;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  webSearchDriver: string;
  webSearchBaseUrl: string;
  webSearchApiKey: string;
}

const EMPTY_FORM: FormState = {
  driver: "",
  baseUrl: "",
  apiKey: "",
  chatModel: "",
  completionModel: "",
  embeddingDriver: "",
  embeddingBaseUrl: "",
  embeddingApiKey: "",
  embeddingModel: "",
  webSearchDriver: "",
  webSearchBaseUrl: "",
  webSearchApiKey: "",
};

export default function AiProviderSettings() {
  const { t } = useTranslation();
  const hasAccess = useHasFeature(Feature.AI);
  const upgradeLabel = useUpgradeLabel();

  const { data: settings, isLoading } = useAiSettingsQuery();
  const updateMutation = useUpdateAiSettingsMutation();
  const resetMutation = useResetAiSettingsMutation();
  const chatModelsMutation = useListAiModelsMutation();
  const embeddingModelsMutation = useListAiModelsMutation();
  const testMutation = useTestAiConnectionMutation();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [chatModels, setChatModels] = useState<string[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<string[]>([]);

  useEffect(() => {
    if (!settings) return;
    setForm({
      driver: settings.driver,
      baseUrl: settings.baseUrl ?? "",
      apiKey: "",
      chatModel: settings.chatModel ?? "",
      completionModel: settings.completionModel ?? "",
      embeddingDriver: (settings.embeddingDriver ?? "") as AiDriver,
      embeddingBaseUrl: settings.embeddingBaseUrl ?? "",
      embeddingApiKey: "",
      embeddingModel: settings.embeddingModel ?? "",
      // `searxng` и пустое значение означают одно и то же, свой сервис в
      // compose. Приводим к пустому, иначе в списке пришлось бы держать два
      // одинаковых по подписи пункта.
      webSearchDriver:
        settings.webSearchDriver === "searxng"
          ? ""
          : (settings.webSearchDriver ?? ""),
      webSearchBaseUrl: settings.webSearchBaseUrl ?? "",
      webSearchApiKey: "",
    });
  }, [settings]);

  /**
   * Каталог моделей эмбеддингов подтягивается сам, без нажатия кнопки.
   *
   * Список был пуст до явного нажатия, поэтому выбрать модель было не из
   * чего: поле со свободным вводом требовало знать имя наизусть. Молча,
   * потому что это фон: отказ провайдера здесь не событие для человека, а
   * кнопка рядом остается для повторной загрузки.
   *
   * Провайдеры, которым для каталога нужен ключ, пропускаются, пока ключа
   * нет: запрос все равно вернул бы отказ.
   */
  useEffect(() => {
    if (!hasAccess) return;
    const driver = form.embeddingDriver || form.driver;
    if (!driver) return;

    const needsKey = driver !== "openrouter" && driver !== "ollama";
    if (needsKey && !settings?.hasApiKey && !settings?.hasEmbeddingApiKey) {
      return;
    }

    void handleLoadModels("embedding", { silent: true });
    // Перезагрузка только при смене провайдера: список зависит от него.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, form.embeddingDriver, form.driver]);

  const translateBaseUrlError = (key: string | null) => (key ? t(key) : null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const webSearchKeyPlaceholder = settings?.webSearchApiKeyPreview
    ? `${t("Stored")}: ${settings.webSearchApiKeyPreview}`
    : t("Enter the provider key");

  const hasUrlError = Boolean(
    baseUrlErrorKey(form.baseUrl) || baseUrlErrorKey(form.embeddingBaseUrl),
  );
  const needsBaseUrl = BASE_URL_REQUIRED.includes(form.driver);
  const canListModels = SUPPORTS_MODEL_LISTING.includes(form.driver);

  const apiKeyPlaceholder = useMemo(() => {
    if (settings?.hasApiKey) {
      return `${t("Stored")}: ${settings.apiKeyPreview}`;
    }
    return t("Paste the provider API key");
  }, [settings, t]);

  const embeddingKeyPlaceholder = useMemo(() => {
    if (settings?.hasEmbeddingApiKey) {
      return `${t("Stored")}: ${settings.embeddingApiKeyPreview}`;
    }
    return t("Paste an API key used only for embeddings");
  }, [settings, t]);

  const handleLoadModels = async (
    kind: "chat" | "embedding",
    opts?: { silent?: boolean },
  ) => {
    const mutation =
      kind === "chat" ? chatModelsMutation : embeddingModelsMutation;
    try {
      const { models } = await mutation.mutateAsync({
        driver:
          (kind === "chat"
            ? form.driver
            : form.embeddingDriver || form.driver) || undefined,
        baseUrl:
          (kind === "chat" ? form.baseUrl : form.embeddingBaseUrl) || undefined,
        apiKey:
          (kind === "chat" ? form.apiKey : form.embeddingApiKey) || undefined,
        kind,
      });
      const ids = models.map((m) => m.id);
      if (kind === "chat") setChatModels(ids);
      else setEmbeddingModels(ids);

      if (ids.length === 0 && !opts?.silent) {
        notifications.show({
          message: t("The provider returned no models."),
          color: "yellow",
        });
      }
    } catch (err: any) {
      if (opts?.silent) return;
      notifications.show({
        message: getApiErrorMessage(err, err?.message),
        color: "red",
      });
    }
  };

  const handleSave = async () => {
    // Secrets are only sent when the admin actually typed one, so saving the
    // form does not wipe a key that is already stored.
    const payload: UpdateAiSettingsDto = {
      driver: form.driver,
      baseUrl: form.baseUrl,
      chatModel: form.chatModel,
      completionModel: form.completionModel,
      embeddingDriver: form.embeddingDriver,
      embeddingBaseUrl: form.embeddingBaseUrl,
      embeddingModel: form.embeddingModel,
      webSearchDriver: form.webSearchDriver as any,
      webSearchBaseUrl: form.webSearchBaseUrl,
    };
    if (form.apiKey) payload.apiKey = form.apiKey;
    if (form.embeddingApiKey) payload.embeddingApiKey = form.embeddingApiKey;
    if (form.webSearchApiKey) payload.webSearchApiKey = form.webSearchApiKey;

    try {
      const result = await updateMutation.mutateAsync(payload);
      setForm((prev) => ({
        ...prev,
        apiKey: "",
        embeddingApiKey: "",
        webSearchApiKey: "",
      }));
      notifications.show({
        message: result.reindexQueued
          ? t("Saved. Re-indexing the workspace with the new embedding model.")
          : t("AI provider settings saved."),
      });
    } catch (err: any) {
      notifications.show({
        message: getApiErrorMessage(err, err?.message),
        color: "red",
      });
    }
  };

  const handleTest = async () => {
    try {
      const result = await testMutation.mutateAsync();
      notifications.show({
        message: result.message,
        color: result.ok ? "green" : "red",
        autoClose: result.ok ? 4000 : 8000,
      });
    } catch (err: any) {
      notifications.show({
        message: getApiErrorMessage(err, err?.message),
        color: "red",
      });
    }
  };

  const handleReset = async () => {
    try {
      await resetMutation.mutateAsync();
      setChatModels([]);
      setEmbeddingModels([]);
      notifications.show({
        message: t("Cleared. AI now follows the server environment again."),
      });
    } catch (err: any) {
      notifications.show({
        message: getApiErrorMessage(err, err?.message),
        color: "red",
      });
    }
  };

  if (isLoading) {
    return <Loader size="sm" />;
  }

  return (
    <Stack gap="lg">
      {!hasAccess && (
        <Alert icon={<IconInfoCircle />} title={upgradeLabel} color="blue">
          {t("AI is only available in the enterprise edition.")}
        </Alert>
      )}

      {settings?.managedByEnv && (
        <Alert icon={<IconInfoCircle />} color="gray">
          {t(
            "AI is currently configured through server environment variables. Picking a provider here overrides them for this workspace.",
          )}
        </Alert>
      )}

      <Group justify="space-between" align="center">
        <Text size="md" fw={500}>
          {t("Provider")}
        </Text>
        {settings?.configured ? (
          <Badge color="green" variant="light">
            {t("Configured")}
          </Badge>
        ) : (
          <Badge color="gray" variant="light">
            {t("Not configured")}
          </Badge>
        )}
      </Group>

      <Select
        label={t("AI provider")}
        description={t("Which service answers and edits documents.")}
        data={DRIVER_OPTIONS.map((o) => ({
          value: o.value,
          label: t(o.label),
        }))}
        value={form.driver}
        onChange={(value) => set("driver", (value ?? "") as AiDriver)}
        disabled={!hasAccess}
        allowDeselect={false}
      />

      {form.driver === "openrouter" && (
        <Text size="sm" c="dimmed">
          <Anchor
            href="https://openrouter.ai/keys"
            target="_blank"
            size="sm"
            rel="noreferrer"
          >
            {t("Create an OpenRouter key")}
          </Anchor>{" "}
          {t(
            "then pick any model it offers, e.g. openai/gpt-5.6-luna. Embeddings are configured separately below.",
          )}
        </Text>
      )}

      {form.driver !== "" && (
        <>
          <TextInput
            label={t("Base URL")}
            description={
              needsBaseUrl
                ? t("Required for this provider.")
                : t("Optional. Leave empty to use the provider default.")
            }
            placeholder={
              form.driver === "openrouter"
                ? "https://openrouter.ai/api/v1"
                : form.driver === "ollama"
                  ? "http://localhost:11434"
                  : "https://api.openai.com/v1"
            }
            value={form.baseUrl}
            onChange={(e) => set("baseUrl", e.currentTarget.value)}
            disabled={!hasAccess}
            error={translateBaseUrlError(baseUrlErrorKey(form.baseUrl))}
            {...NO_AUTOFILL}
          />

          {form.driver !== "ollama" && (
            <PasswordInput
              label={t("API key")}
              description={t(
                "Stored encrypted. Leave empty to keep the current key.",
              )}
              placeholder={apiKeyPlaceholder}
              value={form.apiKey}
              onChange={(e) => set("apiKey", e.currentTarget.value)}
              disabled={!hasAccess}
              {...NO_AUTOFILL}
              autoComplete="new-password"
            />
          )}

          <Group align="flex-end" grow>
            <Autocomplete
              label={t("Chat model")}
              description={t("Used by Ask AI and the chat sidebar.")}
              data={chatModels}
              value={form.chatModel}
              onChange={(value) => set("chatModel", value)}
              placeholder={t("e.g. gpt-5.6-luna")}
              disabled={!hasAccess}
            />
            <Autocomplete
              label={t("Completion model")}
              description={t("Used by the editor AI actions.")}
              data={chatModels}
              value={form.completionModel}
              onChange={(value) => set("completionModel", value)}
              placeholder={t("e.g. gpt-5.6-luna")}
              disabled={!hasAccess}
            />
          </Group>

          {canListModels && (
            <Group>
              <Button
                variant="default"
                size="xs"
                leftSection={<IconRefresh size={14} />}
                loading={chatModelsMutation.isPending}
                onClick={() => handleLoadModels("chat")}
                disabled={!hasAccess}
              >
                {t("Fetch models from provider")}
              </Button>
              {chatModels.length > 0 && (
                <Text size="xs" c="dimmed">
                  {chatModels.length} {t("models available")}
                </Text>
              )}
            </Group>
          )}
        </>
      )}

      <Divider
        my="xs"
        label={t("Embeddings (semantic search)")}
        labelPosition="left"
      />

      <Text size="sm" c="dimmed">
        {t(
          "Embeddings keep their own key, address and model, so search does not depend on the chat setup. Changing the provider or the model re-indexes the workspace.",
        )}
      </Text>

      <Select
        label={t("Embedding provider")}
        description={t(
          "Leave as the chat provider unless embeddings live elsewhere. The model list is loaded from the provider automatically.",
        )}
        data={EMBEDDING_DRIVER_OPTIONS.map((o) => ({
          value: o.value,
          label: t(o.label),
        }))}
        value={form.embeddingDriver}
        onChange={(value) => set("embeddingDriver", (value ?? "") as AiDriver)}
        disabled={!hasAccess}
        allowDeselect={false}
      />

      <PasswordInput
        label={t("Embedding API key")}
        description={t(
          "Optional. Falls back to the chat key when the embedding provider is the same as the chat provider.",
        )}
        placeholder={embeddingKeyPlaceholder}
        value={form.embeddingApiKey}
        onChange={(e) => set("embeddingApiKey", e.currentTarget.value)}
        disabled={!hasAccess}
        {...NO_AUTOFILL}
        autoComplete="new-password"
      />

      <TextInput
        label={t("Embedding base URL")}
        description={t(
          "Optional. Defaults to the address of the selected provider.",
        )}
        placeholder="https://api.openai.com/v1"
        value={form.embeddingBaseUrl}
        onChange={(e) => set("embeddingBaseUrl", e.currentTarget.value)}
        disabled={!hasAccess}
        error={translateBaseUrlError(baseUrlErrorKey(form.embeddingBaseUrl))}
        {...NO_AUTOFILL}
      />

      <Autocomplete
        label={t("Embedding model")}
        description={t(
          "The model must return 1536 values, the width of the index. Models that support the dimensions parameter are narrowed to it automatically.",
        )}
        data={embeddingModels}
        value={form.embeddingModel}
        onChange={(value) => set("embeddingModel", value)}
        placeholder="text-embedding-3-small"
        disabled={!hasAccess}
      />

      <Group>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconRefresh size={14} />}
          loading={embeddingModelsMutation.isPending}
          onClick={() => handleLoadModels("embedding")}
          disabled={!hasAccess}
        >
          {t("Fetch embedding models")}
        </Button>
      </Group>

      <Divider my="xs" label={t("Web search")} labelPosition="left" />

      <Text size="sm" c="dimmed">
        {t(
          "The agent searches the web when a question needs current information. The bundled search service runs alongside the app and needs no key; the other providers are external and require one.",
        )}
      </Text>

      <Select
        label={t("Search provider")}
        data={[
          { value: "", label: t("Bundled search service (no key needed)") },
          { value: "tavily", label: "Tavily" },
          { value: "brave", label: "Brave Search" },
          { value: "off", label: t("Disabled") },
        ]}
        value={form.webSearchDriver}
        onChange={(value) => set("webSearchDriver", value ?? "")}
        disabled={!hasAccess}
        allowDeselect={false}
      />

      {(form.webSearchDriver === "tavily" ||
        form.webSearchDriver === "brave") && (
        <PasswordInput
          label={t("Search API key")}
          placeholder={webSearchKeyPlaceholder}
          value={form.webSearchApiKey}
          onChange={(e) => set("webSearchApiKey", e.currentTarget.value)}
          disabled={!hasAccess}
          {...NO_AUTOFILL}
          autoComplete="new-password"
        />
      )}

      {(form.webSearchDriver === "" || form.webSearchDriver === "searxng") && (
        <TextInput
          label={t("Search service URL")}
          description={t(
            "Leave empty to use the bundled service at http://tessera-searxng:8080.",
          )}
          placeholder="http://tessera-searxng:8080"
          value={form.webSearchBaseUrl}
          onChange={(e) => set("webSearchBaseUrl", e.currentTarget.value)}
          disabled={!hasAccess}
        />
      )}

      <Group justify="space-between" mt="md">
        <Group>
          <Button
            onClick={handleSave}
            loading={updateMutation.isPending}
            disabled={!hasAccess || hasUrlError}
          >
            {t("Save")}
          </Button>
          <Button
            variant="default"
            onClick={handleTest}
            loading={testMutation.isPending}
            disabled={!hasAccess}
          >
            {t("Test connection")}
          </Button>
        </Group>
        <Button
          variant="subtle"
          color="red"
          onClick={handleReset}
          loading={resetMutation.isPending}
          disabled={!hasAccess}
        >
          {t("Clear and use environment")}
        </Button>
      </Group>
    </Stack>
  );
}
