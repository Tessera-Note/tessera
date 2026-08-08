import { Injectable } from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import type { CacheItem, CacheProvider } from '@node-saml/passport-saml';

/**
 * Префикс ключей. Идентификаторы запросов лежат в общем Redis рядом с
 * сессиями, очередями и кешем прав, поэтому пространство имен обязательно.
 */
const KEY_PREFIX = 'saml:req';

@Injectable()
export class SamlRequestCache {
  private readonly redis: Redis;

  constructor(private readonly redisService: RedisService) {
    this.redis = this.redisService.getOrThrow();
  }

  /**
   * Хранилище идентификаторов выданных запросов для сверки `InResponseTo`.
   *
   * В Redis, а не в памяти процесса: библиотека при отсутствии хранилища молча
   * подставляет свое, процесс-локальное, и на нескольких экземплярах
   * приложения вход ломается тихо. Запрос выдал один процесс, ответ пришел
   * в другой, идентификатор не найден, вход отвергнут без внятной причины.
   *
   * Ключ привязан к провайдеру. Формально этого достаточно и без привязки,
   * идентификатор случайный, но так сверка не зависит от корректности
   * `RelayState`: два независимых механизма лучше одного, продублированного.
   *
   * Срок жизни задается вызывающим и совпадает со сроком жизни состояния
   * потока. Короткий срок здесь важен: библиотека снимает ключ не на всех
   * путях разбора ответа, и одноразовость идентификатора обеспечивается
   * в том числе истечением.
   */
  forProvider(providerId: string, ttlMs: number): CacheProvider {
    const keyOf = (key: string) => `${KEY_PREFIX}:${providerId}:${key}`;

    return {
      /**
       * Возвращает `null`, если ключ уже занят: так требует контракт
       * библиотеки. Вставка идет через `NX`, а не проверкой перед записью,
       * чтобы два одновременных запроса не получили один ключ.
       */
      saveAsync: async (
        key: string,
        value: string,
      ): Promise<CacheItem | null> => {
        const stored = await this.redis.set(
          keyOf(key),
          value,
          'PX',
          ttlMs,
          'NX',
        );
        if (stored !== 'OK') return null;
        return { value, createdAt: Date.now() };
      },

      /**
       * Отдает ровно ту строку, что была сохранена: библиотека разбирает ее
       * обратно как момент выдачи и сверяет возраст запроса.
       */
      getAsync: async (key: string): Promise<string | null> =>
        this.redis.get(keyOf(key)),

      /**
       * Принимает `null`: библиотека вызывает снятие и тогда, когда
       * идентификатора в ответе не оказалось.
       */
      removeAsync: async (key: string | null): Promise<string | null> => {
        if (!key) return null;
        const removed = await this.redis.del(keyOf(key));
        return removed > 0 ? key : null;
      },
    };
  }
}
