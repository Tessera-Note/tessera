import { Injectable, BadRequestException } from '@nestjs/common';
import { generateText, streamText } from 'ai';
import { AiProviderFactory } from './ai-provider.factory';
import { DEFAULT_AI_LANGUAGE, languageFromLocale } from './ai-language.util';

export enum AiAction {
  IMPROVE_WRITING = 'improve_writing',
  FIX_SPELLING_GRAMMAR = 'fix_spelling_grammar',
  MAKE_SHORTER = 'make_shorter',
  MAKE_LONGER = 'make_longer',
  SIMPLIFY = 'simplify',
  CHANGE_TONE = 'change_tone',
  SUMMARIZE = 'summarize',
  EXPLAIN = 'explain',
  CONTINUE_WRITING = 'continue_writing',
  TRANSLATE = 'translate',
  CUSTOM = 'custom',
}

const ACTION_PROMPTS: Record<string, string> = {
  [AiAction.IMPROVE_WRITING]:
    'Improve the writing quality of the following text. Make it clearer, more concise, and better structured while preserving the original meaning. Return only the improved text without explanations.',
  [AiAction.FIX_SPELLING_GRAMMAR]:
    'Fix all spelling and grammar errors in the following text. Return only the corrected text without explanations.',
  [AiAction.MAKE_SHORTER]:
    'Make the following text shorter and more concise while preserving the key information. Return only the shortened text without explanations.',
  [AiAction.MAKE_LONGER]:
    'Expand and elaborate on the following text with more detail and examples while maintaining the same tone. Return only the expanded text without explanations.',
  [AiAction.SIMPLIFY]:
    'Simplify the following text so it can be easily understood. Use simpler words and shorter sentences. Return only the simplified text without explanations.',
  [AiAction.CHANGE_TONE]:
    'Change the tone of the following text to be more professional and formal. Return only the modified text without explanations.',
  [AiAction.SUMMARIZE]:
    'Summarize the following text into a brief overview capturing the main points. Return only the summary without explanations.',
  [AiAction.EXPLAIN]:
    'Explain the following text in simple terms. Break down complex concepts and make it accessible. Return only the explanation.',
  [AiAction.CONTINUE_WRITING]:
    'Continue writing the following text naturally, maintaining the same style, tone, and context. Return only the continuation without repeating the original text.',
  [AiAction.TRANSLATE]:
    'Translate the following text to {{language}}. If it is already in {{language}}, translate it to English. Return only the translation without explanations.',
};

@Injectable()
export class AiService {
  constructor(private readonly providerFactory: AiProviderFactory) {}

  async generate(data: {
    action?: string;
    content: string;
    prompt?: string;
    workspaceId: string;
    locale?: string | null;
  }) {
    if (!(await this.providerFactory.isConfigured(data.workspaceId))) {
      throw new BadRequestException('AI is not configured');
    }

    const systemPrompt = this.buildPrompt(
      data.action,
      data.prompt,
      languageFromLocale(data.locale),
    );

    const result = await generateText({
      model: await this.providerFactory.getCompletionModel(data.workspaceId),
      system: systemPrompt,
      prompt: data.content,
    });

    const usage = result.usage as any;
    return {
      content: result.text,
      usage: usage
        ? {
            promptTokens: usage.promptTokens ?? usage.inputTokens ?? 0,
            completionTokens: usage.completionTokens ?? usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
          }
        : undefined,
    };
  }

  async *generateStream(data: {
    action?: string;
    content: string;
    prompt?: string;
    workspaceId: string;
    locale?: string | null;
  }) {
    if (!(await this.providerFactory.isConfigured(data.workspaceId))) {
      throw new BadRequestException('AI is not configured');
    }

    const systemPrompt = this.buildPrompt(
      data.action,
      data.prompt,
      languageFromLocale(data.locale),
    );

    const result = streamText({
      model: await this.providerFactory.getCompletionModel(data.workspaceId),
      system: systemPrompt,
      prompt: data.content,
    });

    for await (const chunk of result.textStream) {
      yield { content: chunk };
    }
  }

  private buildPrompt(
    action?: string,
    customPrompt?: string,
    language: string = DEFAULT_AI_LANGUAGE,
  ): string {
    // Every action rewrites the user's own text, so the output has to stay in
    // their language rather than drifting to the prompt's.
    const languageRule = `Write your output in ${language}, unless the text you are given is in another language — then keep that language. `;

    if (action === AiAction.CUSTOM && customPrompt) {
      return `${languageRule}${customPrompt}`;
    }

    if (action && ACTION_PROMPTS[action]) {
      const base = ACTION_PROMPTS[action].replace(/\{\{language\}\}/g, language);
      const prefix = action === AiAction.TRANSLATE ? '' : languageRule;

      if (customPrompt) {
        return `${prefix}${base}\n\nAdditional instructions: ${customPrompt}`;
      }
      return `${prefix}${base}`;
    }

    return (
      customPrompt ||
      `${languageRule}You are a helpful writing assistant. Help the user with their request.`
    );
  }
}
