import { BadRequestException } from '@nestjs/common';
import { AiSettingsService } from './ai-settings.service';
import { AiProviderFactory } from './ai-provider.factory';

/**
 * Провайдер эмбеддингов раньше был жестко OpenAI: клиент собирался прямо в
 * `EmbeddingService`, мимо механизма выбора провайдера. Проверяется, что
 * выбор идет тем же путем, что и у чата, и что ключ чата не утекает к чужому
 * провайдеру.
 */
function build(
  row: Record<string, unknown> | null,
  env: Record<string, any> = {},
) {
  const repo: any = { findByWorkspaceId: jest.fn(async () => row) };
  const environmentService: any = {
    getAppSecret: () => 'x'.repeat(32),
    getAiDriver: () => env.aiDriver ?? null,
    getOpenAiApiKey: () => env.openAiKey ?? null,
    getOpenAiApiUrl: () => env.openAiUrl ?? null,
    getOllamaApiUrl: () => env.ollamaUrl ?? null,
  };

  const service = new AiSettingsService(repo, environmentService);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
  return { service, repo };
}

/** Шифротекст подделывать незачем: расшифровка подменяется на месте. */
jest.mock('./ai-secret.util', () => ({
  ...jest.requireActual('./ai-secret.util'),
  decryptSecret: (value: string | null) =>
    value ? value.replace('enc:', '') : null,
  encryptSecret: (value: string) => `enc:${value}`,
  maskSecret: (value: string | null) => (value ? '***' : null),
}));

describe('resolveEmbedding, выбор провайдера', () => {
  it('без своей настройки наследует провайдера чата', async () => {
    const { service } = build({
      driver: 'openrouter',
      embeddingDriver: null,
      apiKeyEncrypted: 'enc:chat-key',
      embeddingApiKeyEncrypted: null,
    });

    const config = await service.resolveEmbedding('ws-1');

    expect(config.driver).toBe('openrouter');
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('свой провайдер перекрывает провайдера чата', async () => {
    const { service } = build({
      driver: 'openrouter',
      embeddingDriver: 'openai',
      apiKeyEncrypted: 'enc:chat-key',
      embeddingApiKeyEncrypted: 'enc:embed-key',
    });

    const config = await service.resolveEmbedding('ws-1');

    expect(config.driver).toBe('openai');
    expect(config.apiKey).toBe('embed-key');
  });

  /**
   * Главная причина, по которой ключ чата нельзя брать безусловно: ключ
   * OpenRouter в OpenAI не работает, и наоборот.
   */
  it('ключ чата не подставляется чужому провайдеру', async () => {
    const { service } = build({
      driver: 'openrouter',
      embeddingDriver: 'openai',
      apiKeyEncrypted: 'enc:chat-key',
      embeddingApiKeyEncrypted: null,
    });

    const config = await service.resolveEmbedding('ws-1');

    expect(config.apiKey).toBeNull();
  });

  it('ключ чата подставляется при совпадении провайдера', async () => {
    const { service } = build({
      driver: 'openrouter',
      embeddingDriver: 'openrouter',
      apiKeyEncrypted: 'enc:chat-key',
      embeddingApiKeyEncrypted: null,
    });

    const config = await service.resolveEmbedding('ws-1');

    expect(config.apiKey).toBe('chat-key');
  });

  it('свой адрес перекрывает адрес провайдера по умолчанию', async () => {
    const { service } = build({
      driver: 'openai',
      embeddingDriver: 'openai-compatible',
      embeddingBaseUrl: 'http://tessera-embed:8080/v1',
      embeddingApiKeyEncrypted: 'enc:k',
    });

    const config = await service.resolveEmbedding('ws-1');

    expect(config.baseUrl).toBe('http://tessera-embed:8080/v1');
    // Идентичность берет именно явный адрес: разрешенный у одного провайдера
    // всегда один и тот же.
    expect(config.baseUrlOverride).toBe('http://tessera-embed:8080/v1');
  });

  /**
   * Наследование делает смену чат-провайдера сменой провайдера эмбеддингов.
   * Переиндексация ставится по разрешенной идентичности именно поэтому.
   */
  it('смена провайдера чата меняет провайдера эмбеддингов при наследовании', async () => {
    const before = build({
      driver: 'openai',
      embeddingDriver: null,
      apiKeyEncrypted: 'enc:k',
    });
    const after = build({
      driver: 'openrouter',
      embeddingDriver: null,
      apiKeyEncrypted: 'enc:k',
    });

    expect((await before.service.resolveEmbedding('ws-1')).driver).toBe(
      'openai',
    );
    expect((await after.service.resolveEmbedding('ws-1')).driver).toBe(
      'openrouter',
    );
  });

  it('без строки настроек провайдер берется из окружения', async () => {
    const { service } = build(null, {
      aiDriver: 'openai',
      openAiKey: 'env-key',
    });

    const config = await service.resolveEmbedding('ws-1');

    expect(config.driver).toBe('openai');
    expect(config.apiKey).toBe('env-key');
  });
});

describe('AiProviderFactory.createEmbeddingModel', () => {
  const factory = new AiProviderFactory({} as any);

  it('без провайдера отказывает, а не собирает клиента по умолчанию', () => {
    expect(() =>
      factory.createEmbeddingModel(
        {
          driver: '',
          baseUrl: null,
          baseUrlOverride: null,
          apiKey: 'k',
          model: null,
        },
        'text-embedding-3-small',
      ),
    ).toThrow(BadRequestException);
  });

  it.each(['openai', 'openrouter', 'openai-compatible', 'gemini', 'ollama'])(
    'собирает модель для провайдера %s',
    (driver) => {
      const model = factory.createEmbeddingModel(
        {
          driver: driver as any,
          baseUrl: driver === 'ollama' ? 'http://localhost:11434' : null,
          baseUrlOverride: null,
          apiKey: 'k',
          model: null,
        },
        'text-embedding-3-small',
      );

      expect(model).toBeTruthy();
    },
  );

  it('неизвестный провайдер отбивается', () => {
    expect(() =>
      factory.createEmbeddingModel(
        {
          driver: 'нет-такого' as any,
          baseUrl: null,
          baseUrlOverride: null,
          apiKey: 'k',
          model: null,
        },
        'm',
      ),
    ).toThrow(BadRequestException);
  });
});

/**
 * Обычный `GET /models` моделей эмбеддингов не показывает: там только то, что
 * отвечает текстом. Их отдает фильтр по выходной модальности, и ключ для
 * этого запроса не нужен.
 */
describe('listEmbeddingModels у OpenRouter', () => {
  function withCatalog(payload: unknown) {
    const { service } = build({
      driver: 'openrouter',
      embeddingDriver: null,
      apiKeyEncrypted: null,
    });
    const fetchJson = jest.fn(async () => payload);
    (service as any).fetchJson = fetchJson;
    return { service, fetchJson };
  }

  const CATALOG = {
    data: [
      {
        id: 'openai/text-embedding-3-small',
        name: 'OpenAI: Text Embedding 3 Small',
        architecture: { output_modalities: ['embeddings'] },
      },
      {
        id: 'qwen/qwen3-embedding-8b',
        name: 'Qwen: Qwen3 Embedding 8B',
        architecture: { output_modalities: ['embeddings'] },
      },
      {
        id: 'openai/gpt-4o-mini',
        name: 'чат, не эмбеддинги',
        architecture: { output_modalities: ['text'] },
      },
    ],
  };

  it('каталог запрашивается фильтром по выходной модальности', async () => {
    const { service, fetchJson } = withCatalog(CATALOG);

    await service.listModels('ws-1', { kind: 'embedding' });

    expect(fetchJson).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models?output_modalities=embeddings',
    );
  });

  it('в список попадают только модели с выходом embeddings', async () => {
    const { service } = withCatalog(CATALOG);

    const { models } = await service.listModels('ws-1', { kind: 'embedding' });

    expect(models.map((m: any) => m.id)).toEqual([
      'openai/text-embedding-3-small',
      'qwen/qwen3-embedding-8b',
    ]);
  });

  // Ключ каталогу не нужен, поэтому его отсутствие не должно отбивать запрос.
  it('без ключа список все равно отдается', async () => {
    const { service } = withCatalog(CATALOG);

    await expect(
      service.listModels('ws-1', { kind: 'embedding' }),
    ).resolves.toBeTruthy();
  });
});
