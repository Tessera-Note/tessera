import { Injectable, BadRequestException } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOllama } from 'ai-sdk-ollama';
import { EmbeddingModel, LanguageModel } from 'ai';
import {
  AiSettingsService,
  ResolvedAiConfig,
  ResolvedEmbeddingConfig,
} from './ai-settings.service';
import { badRequest } from '../../common/errors/app-error';

@Injectable()
export class AiProviderFactory {
  constructor(private readonly aiSettingsService: AiSettingsService) {}

  async isConfigured(workspaceId: string): Promise<boolean> {
    return this.aiSettingsService.isConfigured(workspaceId);
  }

  async getCompletionModel(workspaceId: string): Promise<LanguageModel> {
    const config = await this.aiSettingsService.resolve(workspaceId);
    return this.createModel(config, config.completionModel);
  }

  async getChatModel(workspaceId: string): Promise<LanguageModel> {
    const config = await this.aiSettingsService.resolve(workspaceId);
    return this.createModel(config, config.chatModel);
  }

  /**
   * Модель эмбеддингов у того же провайдера, что и остальные модели.
   *
   * Отдельного пути здесь нет намеренно: список провайдеров, разбор адреса и
   * хранение ключа общие с чатом, отличается только вызываемый метод клиента.
   */
  createEmbeddingModel(
    config: ResolvedEmbeddingConfig,
    modelId: string,
  ): EmbeddingModel {
    if (!config.driver) {
      throw badRequest('error.ai.ai_is_not_configured_set_it');
    }

    switch (config.driver) {
      case 'openai':
      case 'openrouter':
      case 'openai-compatible': {
        const openai = createOpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseUrl || undefined,
        });
        return openai.textEmbeddingModel(modelId);
      }
      case 'gemini': {
        const google = createGoogleGenerativeAI({
          apiKey: config.apiKey,
        });
        return google.textEmbeddingModel(modelId);
      }
      case 'ollama': {
        const ollama = createOllama({
          baseURL: config.baseUrl,
        });
        return ollama.textEmbeddingModel(modelId);
      }
      default:
        throw badRequest('error.ai.unknown_driver', { driver: config.driver });
    }
  }

  /** Used by the settings screen to exercise a config before relying on it. */
  createModel(config: ResolvedAiConfig, modelId?: string): LanguageModel {
    if (!config.driver) {
      throw badRequest('error.ai.ai_is_not_configured_set_it');
    }

    const effectiveModel =
      modelId ||
      config.completionModel ||
      this.aiSettingsService.defaultModelFor(config.driver);

    switch (config.driver) {
      // OpenRouter and any other OpenAI-compatible gateway differ from OpenAI
      // only by base URL, which resolve() has already filled in.
      case 'openai':
      case 'openrouter':
      case 'openai-compatible': {
        const openai = createOpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseUrl || undefined,
        });
        return openai.chat(effectiveModel);
      }
      case 'gemini': {
        const google = createGoogleGenerativeAI({
          apiKey: config.apiKey,
        });
        return google(effectiveModel);
      }
      case 'ollama': {
        const ollama = createOllama({
          baseURL: config.baseUrl,
        });
        return ollama(effectiveModel);
      }
      default:
        throw badRequest('error.ai.unknown_driver', { driver: config.driver });
    }
  }
}
