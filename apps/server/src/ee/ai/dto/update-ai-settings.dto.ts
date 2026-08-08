import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { AI_DRIVERS, WEB_SEARCH_DRIVERS } from '../ai-settings.service';

/**
 * Browsers happily autofill a bare text field with an email or username, and an
 * unvalidated value here ends up as the API host — so the URL has to carry an
 * explicit protocol. TLDs are optional because `http://localhost:11434` and
 * container hostnames are legitimate targets.
 */
const BASE_URL_RULES = {
  require_protocol: true,
  require_tld: false,
  protocols: ['http', 'https'],
};

export class UpdateAiSettingsDto {
  /** Empty string clears the override and hands control back to the env. */
  @IsOptional()
  @IsString()
  @IsIn([...AI_DRIVERS, ''])
  driver?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ValidateIf((_, value) => typeof value === 'string' && value.trim() !== '')
  @IsUrl(BASE_URL_RULES, {
    message: 'baseUrl must be a full URL, e.g. https://openrouter.ai/api/v1',
  })
  baseUrl?: string;

  /**
   * Omit to keep the stored key, send an empty string to delete it. The value
   * is never echoed back by the API.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  chatModel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  completionModel?: string;

  /** Пустая строка означает «тот же провайдер, что у чата». */
  @IsOptional()
  @IsString()
  @IsIn([...AI_DRIVERS, ''])
  embeddingDriver?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ValidateIf((_, value) => typeof value === 'string' && value.trim() !== '')
  @IsUrl(BASE_URL_RULES, {
    message:
      'embeddingBaseUrl must be a full URL, e.g. https://api.openai.com/v1',
  })
  embeddingBaseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  embeddingApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  embeddingModel?: string;

  /** Пустая строка возвращает выбор по умолчанию, свой сервис в compose. */
  @IsOptional()
  @IsString()
  @IsIn([...WEB_SEARCH_DRIVERS, ''])
  webSearchDriver?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ValidateIf((_, value) => typeof value === 'string' && value.trim() !== '')
  @IsUrl(BASE_URL_RULES, {
    message:
      'webSearchBaseUrl must be a full URL, e.g. http://tessera-searxng:8080',
  })
  webSearchBaseUrl?: string;

  /** Пропущен — прежний ключ сохраняется, пустая строка стирает. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  webSearchApiKey?: string;
}

export class ListAiModelsDto {
  @IsOptional()
  @IsString()
  @IsIn([...AI_DRIVERS, ''])
  driver?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ValidateIf((_, value) => typeof value === 'string' && value.trim() !== '')
  @IsUrl(BASE_URL_RULES)
  baseUrl?: string;

  /** Lets an admin browse models with a key that has not been saved yet. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @IsIn(['chat', 'embedding'])
  kind?: string;
}
