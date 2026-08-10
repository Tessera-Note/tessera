import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { TransformHttpResponseInterceptor } from './common/interceptors/http-response.interceptor';
import { WsRedisIoAdapter } from './ws/adapter/ws-redis.adapter';
import fastifyMultipart from '@fastify/multipart';
import fastifyCookie from '@fastify/cookie';
import fastifyIp from 'fastify-ip';
import { InternalLogFilter } from './common/logger/internal-log-filter';
import { UniqueViolationFilter } from './common/filters/unique-violation.filter';
import { EnvironmentService } from './integrations/environment/environment.service';
import { resolveFrameHeader } from './common/helpers';
import { notFound } from './common/errors/app-error';

/**
 * Сколько обратных прокси стоит перед приложением.
 *
 * Читается напрямую из окружения, а не из `EnvironmentService`: адаптер
 * создается до того, как поднимется контейнер зависимостей.
 */
function trustProxyHops(): number {
  const raw = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '', 10);

  // Ноль пропускается как допустимый выбор, отбрасывается только мусор и
  // отрицательные значения. Но ноль делает больше, чем «не доверять никому»:
  // Fastify считает его ложным и собирает обычный запрос, поэтому пропадает
  // не только разбор `X-Forwarded-For`, но и учет `X-Forwarded-Proto` с
  // `X-Forwarded-Host`. Сегодня ни `req.ips`, ни `request.protocol`, ни
  // `request.host` в коде не читаются, так что вреда нет, но выбирать ноль
  // надо зная это.
  return Number.isInteger(raw) && raw >= 0 ? raw : 1;
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Rich pages and templates can contain large tables, code blocks and diagrams.
      bodyLimit: 10 * 1024 * 1024,
      // Число доверенных переходов, а не `true`.
      //
      // При `true` Fastify доверяет всей цепочке `X-Forwarded-For` и берет
      // самое левое значение, то есть присланное клиентом. Замерено: заголовок
      // `203.0.113.99, 10.0.0.7`, где правое значение приписал прокси, при
      // `true` дает `req.ip = 203.0.113.99`, при одном переходе `10.0.0.7`.
      //
      // По `req.ip` считаются пороги частоты и пишется адрес в журнал аудита,
      // поэтому доверие всей цепочке означало и обход лимита подстановкой
      // заголовка, и подделку адреса в журнале. На публичном маршруте отрисовки
      // PDF адрес вообще единственная идентичность.
      //
      // Единица потому, что перед приложением стоит ровно один обратный прокси
      // и он приписывает реальный адрес (`$proxy_add_x_forwarded_for` в
      // `deploy/nginx`). Развертыванию с дополнительным прокси впереди,
      // например с CDN, число задается переменной `TRUST_PROXY_HOPS`.
      trustProxy: trustProxyHops(),
      routerOptions: {
        maxParamLength: 1000,
        ignoreTrailingSlash: true,
        ignoreDuplicateSlashes: true,
      },
    }),
    {
      rawBody: true,
      // captures NestJS internal errors
      logger: new InternalLogFilter(),
      // bufferLogs must be false else pino will fail
      // to log OnApplicationBootstrap logs
      bufferLogs: false,
    },
  );

  app.useLogger(app.get(PinoLogger));

  app.setGlobalPrefix('api', {
    // 'api/mcp' must be excluded too, otherwise the global prefix turns it
    // into /api/api/mcp and /api/mcp falls through to the SPA.
    exclude: ['robots.txt', 'share/:shareId/p/:pageSlug', 'mcp', 'api/mcp'],
  });

  const reflector = app.get(Reflector);
  const redisIoAdapter = new WsRedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();

  app.useWebSocketAdapter(redisIoAdapter);

  await app.register(fastifyIp);
  await app.register(fastifyMultipart);
  await app.register(fastifyCookie);

  const environmentService = app.get(EnvironmentService);
  const frameHeader = resolveFrameHeader(
    environmentService.isIframeEmbedAllowed(),
    environmentService.getIframeAllowedOrigins(),
  );
  if (frameHeader) {
    // Skipped routes:
    //   /api/files/ - attachment controller sets its own CSP we'd overwrite
    //   /share/     0 public share pages are safe to embed
    const frameHeaderSkippedPrefixes = ['/api/files/', '/share/'];
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onSend', (req, reply, payload, done) => {
        if (frameHeaderSkippedPrefixes.some((p) => req.url.startsWith(p))) {
          return done(null, payload);
        }
        reply.header(frameHeader.name, frameHeader.value);
        done(null, payload);
      });
  }

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, _reply, done) => {
      (request.raw as any).ip = request.ip;
      done();
    });

  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(
      'application/scim+json',
      { parseAs: 'string' },
      (_, body, done) => {
        try {
          const json = JSON.parse(body.toString());
          done(null, json);
        } catch (err: any) {
          done(err);
        }
      },
    );

  app
    .getHttpAdapter()
    .getInstance()
    .decorateReply('setHeader', function (name: string, value: unknown) {
      this.header(name, value);
    })
    .decorateReply('end', function () {
      this.send('');
    })
    .addHook('preHandler', function (req, reply, done) {
      // don't require workspaceId for the following paths
      const excludedPaths = [
        '/api/auth/setup',
        '/api/health',
        '/api/billing/stripe/webhook',
        '/api/workspace/check-hostname',
        '/api/sso/google',
        '/api/workspace/create',
        '/api/workspace/joined',
        '/api/workspace/find-by-email',
      ];

      if (
        req.originalUrl.startsWith('/api') &&
        !excludedPaths.some((path) => req.originalUrl.startsWith(path))
      ) {
        if (!req.raw?.['workspaceId'] && req.originalUrl !== '/api') {
          throw notFound('error.workspace.not_found');
        }
        done();
      } else {
        done();
      }
    });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      stopAtFirstError: true,
      transform: true,
    }),
  );

  app.enableCors();
  // Нарушение уникального ограничения это отказ, а не поломка: без фильтра
  // одновременное создание объекта с занятым именем отдает 500.
  app.useGlobalFilters(
    new UniqueViolationFilter(app.get(HttpAdapterHost).httpAdapter),
  );
  app.useGlobalInterceptors(new TransformHttpResponseInterceptor(reflector));
  app.enableShutdownHooks();

  const logger = new Logger('NestApplication');

  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`UnhandledRejection, reason: ${reason}`, promise);
  });

  process.on('uncaughtException', (error) => {
    logger.error('UncaughtException:', error);
  });

  const port = process.env.PORT || 3000;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host, () => {
    logger.log(
      `Listening on http://127.0.0.1:${port} / ${process.env.APP_URL}`,
    );
  });
}

bootstrap();
