import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { EnvironmentService } from '../environment/environment.service';
import { EnvironmentModule } from '../environment/environment.module';
import { parseRedisUrl } from '../../common/helpers';
import {
  AUTH_THROTTLER,
  AI_CHAT_THROTTLER,
  EXPORT_THROTTLER,
  LDAP_LOGIN_THROTTLER,
} from './throttler-names';
import Redis from 'ioredis';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [EnvironmentModule],
      useFactory: (environmentService: EnvironmentService) => {
        const redisConfig = parseRedisUrl(environmentService.getRedisUrl());

        return {
          throttlers: [
            { name: AUTH_THROTTLER, ttl: 60_000, limit: 10 },
            { name: AI_CHAT_THROTTLER, ttl: 60_000, limit: 25 },
            { name: EXPORT_THROTTLER, ttl: 60_000, limit: 10 },
            // Счетчик входа через каталог объявлен здесь только потому, что
            // именованный счетчик обязан быть в общей настройке. Настоящий
            // порог задан на самом маршруте входа декоратором `@Throttle`, а
            // здесь он намеренно свободный.
            //
            // Причина: любой `ThrottlerGuard` проверяет **все** объявленные
            // счетчики, кроме явно пропущенных. С порогом в пять запросов за
            // пять минут этот счетчик молча ограничивал двенадцать
            // контроллеров: чат, ИИ, MCP, экспорт, SSO, MFA и вход. Открытие
            // чата тратило пять запросов и получало отказ на пять минут.
            //
            // Свободное значение здесь безопаснее списка исключений на каждом
            // контроллере: следующий контроллер не обязан помнить про чужой
            // счетчик.
            { name: LDAP_LOGIN_THROTTLER, ttl: 300_000, limit: 1_000_000 },
          ],
          errorMessage: 'Too many requests',
          storage: new ThrottlerStorageRedisService(
            new Redis({
              host: redisConfig.host,
              port: redisConfig.port,
              password: redisConfig.password,
              db: redisConfig.db,
              family: redisConfig.family,
              keyPrefix: 'throttle:',
            }),
          ),
        };
      },
      inject: [EnvironmentService],
    }),
  ],
})
export class ThrottleModule {}
