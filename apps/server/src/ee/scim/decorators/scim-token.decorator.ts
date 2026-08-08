import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Токен, которым провайдер аутентифицировался.
 *
 * Кладет его `ScimAuthGuard`. Нужен журналу аудита: у изменений, пришедших
 * из каталога, автора-человека нет, и без имени токена запись в журнале не
 * позволяет понять, какая именно интеграция завела или отключила участника.
 */
export const ScimToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest()?.scimToken ?? null,
);
