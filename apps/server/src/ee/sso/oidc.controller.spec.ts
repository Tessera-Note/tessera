import { ThrottlerGuard } from '@nestjs/throttler';
import { OidcController } from './oidc.controller';
import { MfaController } from '../mfa/mfa.controller';
import { AuthController } from '../../core/auth/auth.controller';

/**
 * Маршруты входа обязаны иметь тот же лимит, что и обычный вход.
 *
 * Проверяется метаданными, а не запросом: guard навешен на класс, и разъезд
 * с `AuthController` заметен только сравнением, а не прогоном одного маршрута.
 */
function guardsOf(target: any): any[] {
  return Reflect.getMetadata('__guards__', target) ?? [];
}

describe('Лимит запросов на маршрутах входа', () => {
  it('у обычного входа лимит есть, это образец', () => {
    expect(guardsOf(AuthController)).toContain(ThrottlerGuard);
  });

  // Маршрут login публичный и заставляет приложение сходить к провайдеру
  // за настройками, без лимита это усилитель запросов к чужому серверу.
  it('вход через OIDC защищен тем же guard', () => {
    expect(guardsOf(OidcController)).toContain(ThrottlerGuard);
  });

  // verify принимает шестизначный код, без лимита он перебирается.
  it('второй фактор защищен тем же guard', () => {
    expect(guardsOf(MfaController)).toContain(ThrottlerGuard);
  });
});
