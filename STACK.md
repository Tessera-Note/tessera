# Стек проекта

Технологии, версии, конфиги, команды и переменные окружения. Источник истины по вопросу «на чем написан проект». На этот файл ссылается `CLAUDE.md`.

Версии указаны точно, как в манифестах. При обновлении зависимости обновлять и эту таблицу.

## Общее

| Технология | Версия | Роль |
|---|---|---|
| Python | 3.13 | рантайм приложения, база образа `python:3.13-slim` |
| uv | 0.10.2 | зависимости и запуск Python-частей |
| Node | 22 | рантайм экранов и сервиса совместного редактирования |
| pnpm | 10.18.3 | пакетный менеджер, поле `packageManager` в корневом `package.json` |
| TypeScript | 5.9.3 | типизация экранов и пакета расширений |

Воркспейсы объявлены в `pnpm-workspace.yaml` как `apps/*` и `packages/*`. Там же живут `overrides`. В поле `pnpm` внутри `package.json` их держать нельзя, pnpm 11 молча игнорирует это поле.

`.npmrc` содержит `shamefully-hoist = true`.

## Приложение, apps/api

| Технология | Версия | Роль |
|---|---|---|
| Litestar | 2.24.0 | HTTP-каркас, контроллеры классами |
| SQLAlchemy | 2.0.51 | модели и запросы, режим async |
| asyncpg | 0.31.0 | драйвер PostgreSQL |
| msgspec | 0.19.0 | DTO запросов и ответов, разбор и сериализация |
| redis (python) | 6.4.0 | кеш, очереди, подписки |
| arq | 0.25.0 | очереди задач и расписание |
| PyJWT | 2.12.1 | токены входа |
| bcrypt | 5.0.0 | хеши паролей |
| aiobotocore | 3.9.0 | хранилище, совместимое с S3 |
| cryptography | 50.0.0 | шифрование ключей провайдеров ИИ |
| ldap3 | 2.9.1 | вход через LDAP |
| signxml | 5.1.0 | подписи SAML |
| python-socketio | 5.16.4 | канал событий |
| pypdf | 6.15.0 | разбор PDF при ввозе и индексации |
| python-docx | 1.2.0 | разбор DOCX |
| pytest + pytest-asyncio | 9.1.1 / 1.4.0 | проверки, режим `asyncio_mode = auto` |
| ruff | 0.16.1 | линт, длина строки 100, набор `E,F,I,UP,B,SIM` |

Хранилище: PostgreSQL с pgvector (образ `pgvector/pgvector:pg18`) и Redis (образ `redis:8`).

Слои направлены в одну сторону: `api` знает `services`, `services` знает `domain` и `infrastructure`. Обратных связей нет.

## Экраны, apps/web

| Технология | Версия | Роль |
|---|---|---|
| SvelteKit | 2.70.2 | каркас, маршруты, серверные загрузчики |
| Svelte | 5.56.8 | компоненты и состояние на рунах |
| adapter-node | 5.5.7 | сборка узлом, а не статикой |
| Vite | 8.0.16 | сборщик и dev-сервер |
| Tailwind CSS | 4.3.3 | стилизация, плагин `@tailwindcss/vite` |
| bits-ui | 2.18.1 | доступные примитивы интерфейса |
| @tabler/icons-svelte | 3.46 | иконки |
| Tiptap | 3.27.1 | редактор, узлы через `@tessera/editor-ext` |
| yjs + y-prosemirror + @hocuspocus/provider | 13.6 / 1.3.7 / 3.4.4 | совместное редактирование |
| socket.io-client | 4.8.3 | канал событий |
| mermaid, katex, lowlight, dompurify | 11.15.0 / 0.16.40 / 3.3.0 / 3.4.11 | диаграммы, формулы, подсветка, санитайзинг |
| @excalidraw/excalidraw | 0.18.0-3a5ef40 | редактор набросков |
| Vitest | 4.1.10 | проверки |
| svelte-check | 4.7.5 | проверка типов |
| Prettier + prettier-plugin-svelte | 3.6.2 / 3.4.1 | форматирование, `lint` это `--check` без автофикса |

`react` и `react-dom` 19.2.7 присутствуют в зависимостях экранов не ради интерфейса: их требует `@excalidraw/excalidraw`, который остаётся React-компонентом и монтируется отдельно.

Алиас `$lib` указывает на `apps/web/src/lib`, объявлен в `svelte.config.js`.

## Совместное редактирование, services/collab

| Технология | Версия | Роль |
|---|---|---|
| Node | 22 | рантайм, образ `node:22-slim` |
| @hocuspocus/server | 3.4.4 | протокол совместного редактирования |
| Tiptap + yjs | 3.27.1 / 13.6 | схема узлов документа и слияние правок |

Сервис собирается на glibc, а не на Alpine: разбор PDF идёт природным модулем, у которого нет сборки под musl. Своих решений о правах он не принимает и в базу не пишет — спрашивает приложение маршрутами `/api/internal/collab/*` с общим секретом `COLLAB_INTERNAL_TOKEN`.

Проверки запускаются встроенным средством Node: `node --test services/collab/src/*.test.js`.

## Внутренний сервис, services/hub

| Технология | Версия | Роль |
|---|---|---|
| Python | 3.13 | рантайм, образ `python:3.13-slim` |
| Litestar | 2.24.0 | HTTP-каркас |
| SQLAlchemy | 2.0.51 | модели и запросы, режим async |
| asyncpg | 0.31.0 | драйвер PostgreSQL |
| Alembic | 1.18.5 | миграции своей базы `tessera_hub` |
| markdown-it-py | 4.2.0 | разметка страниц документации |
| pytest | 9.1.1 | проверки, SQLite во временном файле |

Сервис закрывает обращения, которые в исходном коде уходили на сторонние адреса: последняя версия, прием телеметрии, документация, лицензия и поддержка. Подробности в `services/hub/README.md`.

## Пакеты

| Пакет | Роль | Особенность |
|---|---|---|
| `@tessera/editor-ext` | общие расширения редактора Tiptap | `module` указывает на исходники `src/index.ts`, сборка через `tsc --build`. Экраны берут типы из `dist`, поэтому пакет собирается первым |

## Конфиг-файлы

| Файл | Роль |
|---|---|
| `package.json` (корень) | скрипты рабочего пространства, общие зависимости редактора |
| `pnpm-workspace.yaml` | воркспейсы и `overrides` |
| `pnpm-lock.yaml`, `apps/api/uv.lock` | замороженные версии, руками не править |
| `.npmrc` | `shamefully-hoist` |
| `apps/api/pyproject.toml` | зависимости приложения, настройки ruff и pytest |
| `apps/api/schema/schema.hcl` | объявленная схема базы, применяется Atlas |
| `apps/api/schema/baseline.sql`, `after-atlas.sql` | снимок схемы и доводка после Atlas, руками не правятся |
| `apps/api/docker-compose.v2.yml` | стенд: приложение со своими базой, Redis и хранилищем |
| `apps/api/docker-compose.v2.server.yml` | боевой состав: те же процессы, база и хранилище общие с прежним экземпляром |
| `apps/api/Dockerfile`, `apps/web/Dockerfile`, `services/collab/Dockerfile` | сборка образов |
| `apps/web/{svelte,vite,vitest}.config.ts`, `tsconfig.json` | конфиги экранов |
| `deploy/nginx/*.conf` | обратный прокси, http и https варианты |
| `deploy/searxng/settings.yml` | настройка своего поиска в сети |
| `deploy/postgres-init/01-hub-database.sh` | создание базы внутреннего сервиса при первом старте |
| `crowdin.yml` | синхронизация переводов **выключена**, причина и порядок включения в самом файле |

## Команды

Корень.

| Скрипт | Команда |
|---|---|
| `pnpm dev` | экраны в режиме разработки |
| `pnpm build` | расширения редактора затем экраны |
| `pnpm clean` | удалить `dist` и `.svelte-kit` |

Приложение, через `uv run --project apps/api <команда>`: `pytest`, `ruff check .`, `litestar --app tessera_api.app:create_app run --reload`.

Экраны, через `pnpm --filter @tessera/web <script>`: `dev`, `build` (шрифты Excalidraw затем Vite), `preview`, `check`, `test`, `lint`.

Пакеты: `pnpm --filter @tessera/editor-ext build`.

Внутренний сервис, в каталоге `services/hub`: `uv run pytest`, `uv run ruff check .`, `uv run alembic upgrade head`.

## Переменные окружения

Приложение читает окружение один раз при сборке, в `apps/api/tessera_api/config.py`. Умолчания задаются там и только там: пустая строка приравнена к отсутствующему значению, потому что compose подставляет пустую строку переменным, которых нет в файле окружения, и без этого правила она перебивала бы умолчание.

Стенд берёт значения из `apps/api/.env`. Обязательны четыре: `APP_SECRET` (не короче 32 знаков), `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `COLLAB_INTERNAL_TOKEN`. Смысл каждой описан в шапке `apps/api/docker-compose.v2.yml`.

Группы переменных, распознаваемых `Settings` (44 имени).

| Группа | Переменные |
|---|---|
| приложение | `APP_URL`, `APP_SECRET`, `HOST`, `PORT`, `DEBUG_MODE`, `TRUST_PROXY_HOPS`, `DISABLE_TELEMETRY` |
| база и очереди | `DATABASE_URL`, `REDIS_URL` |
| хранилище | `STORAGE_DRIVER`, `STORAGE_LOCAL_PATH`, `AWS_S3_ACCESS_KEY_ID`, `AWS_S3_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`, `AWS_S3_REGION`, `AWS_S3_ENDPOINT`, `AWS_S3_FORCE_PATH_STYLE`, `FILE_UPLOAD_SIZE_LIMIT`, `FILE_IMPORT_SIZE_LIMIT` |
| почта | `MAIL_DRIVER`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME`, `SMTP_PASSWORD` |
| экспорт PDF | `GOTENBERG_URL`, `PDF_RENDER_BASE_URL`, `PDF_EXPORT_TIMEOUT` |
| ИИ | `AI_DRIVER`, `AI_BASE_URL`, `AI_CHAT_MODEL`, `AI_COMPLETION_MODEL`, `AI_EMBEDDING_MODEL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_API_URL` |
| вход через провайдера | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| соседние службы | `HUB_INTERNAL_URL`, `HUB_URL`, `CONTENT_SERVICE_URL`, `COLLAB_INTERNAL_TOKEN` |

Экраны читают три значения: `API_INTERNAL_URL` (адрес приложения для отрисовки на сервере, только в `hooks.server.ts`, в браузер не попадает), `PUBLIC_API_URL` и `PUBLIC_DRAWIO_URL`.

Сервис совместного редактирования читает `API_URL`, `COLLAB_INTERNAL_TOKEN`, `HOST`, `PORT`, `MAX_PDF_BODY` и четыре порога слияния: `COLLAB_DEBOUNCE_MS`, `COLLAB_MAX_DEBOUNCE_MS`, `COLLAB_BACKEND_TIMEOUT_MS`, `COLLAB_SWEEP_INTERVAL_MS`. `COLLAB_ALLOW_UNNAMED_DOCUMENT` (`true` или `1`, по умолчанию выключен) пускает подключения без имени документа в адресе — только на время раскатки при одной реплике, порядок в `docs/v2-migration/09-switchover.md`.

Только compose: `LOCAL_PORT`, `POSTGRES_PASSWORD`, `HUB_POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_BUCKET`, `MINIO_REGION`, `SEARXNG_SECRET`, `PDF_ALLOW_LIST`.

`TRUST_PROXY_HOPS` это число обратных прокси перед приложением, по умолчанию 1. От него зависит, какой адрес считается адресом клиента: он идет в пороги частоты и в журнал аудита. Значение «доверять всей цепочке `X-Forwarded-For`» намеренно недоступно: оно позволяет подставить адрес заголовком.

При добавлении любой новой переменной обновить `.env.example` и `Settings`.

## Локализация

Словари лежат по одному файлу на локаль в `apps/web/static/locales` и загружаются приложением. Отдельного движка нет: подстановка и множественные формы реализованы в `apps/web/src/lib/i18n`.

Локали: `de-DE`, `en-US`, `es-ES`, `fr-FR`, `it-IT`, `ja-JP`, `ko-KR`, `nl-NL`, `pt-BR`, `ru-RU`, `uk-UA`, `zh-CN`.

Наборы ключей совпадают: 2318 у десяти локалей и 2336 у `ru-RU` и `uk-UA` (разница это славянские формы `_few` и `_many` у девяти множественных семейств). Совпадение проверяет `apps/web/src/lib/i18n/dictionaries.test.ts`, соответствие кодов отказов — `error-codes.test.ts`.

Переводы **не** синхронизируются: Crowdin выключен, словари ведутся в репозитории и правятся напрямую. Довод и порядок включения в `crowdin.yml`.

## Порты и сеть

| Порт | Что |
|---|---|
| 8080 | `LOCAL_PORT`, единственный внешний порт стенда: за ним прокси |
| 3000 | приложение внутри состава, снаружи стенда 3100 |
| 3001 | сервис совместного редактирования, снаружи стенда 3101 |
| 3200 | dev-сервер Vite, проксирует `/api`, `/socket.io` и `/collab` |
| 4000 | tessera-v2-hub: версии, телеметрия, документация, лицензия, поддержка |
| 8081 | tessera-v2-drawio: редактор диаграмм |
| 9000, 9001 | tessera-v2-minio: хранилище вложений и его консоль |

Прокси нужен и на своей машине: за одним адресом стоят три процесса, и без него браузер ходил бы на три разных происхождения, а кука входа стала бы сторонней.

Два независимых realtime-канала: сырой WebSocket `/collab` (Hocuspocus/Yjs, документы вида `page.<pageId>`) и Socket.IO (дерево, страницы, комментарии, уведомления, кеш).

## Что зафиксировано

- версии мажоров не мигрируются без отдельной задачи
- бизнес-логика, права и запись в базу только на Python. Исключение одно и закрытое, см. `CLAUDE.md`
- схема базы объявляется в `schema.hcl` и применяется Atlas. Файлов миграций в коде приложения нет
- стилизация через Tailwind. Другой подход к стилям не вводить
- состояние экранов на рунах Svelte 5. Библиотеки серверного состояния здесь нет: данные приходят серверными загрузчиками маршрута и модулями `lib/features/<домен>/services`
- отказы приходят кодом (`error.*`), человеку их разворачивает словарь. Готовый текст с сервера не приходит
- шрифты Excalidraw отдаёт само приложение из `apps/web/static/excalidraw-assets`, каталог кладёт сборка

## Особенности

- часть проверок приложения работает против настоящей базы и без `DATABASE_URL` пропускается, часть — против настоящего Redis и пропускается без `REDIS_URL`. Зелёный прогон без любой из двух переменных не означает, что проверено всё; полный прогон делается с обеими
- проверки на настоящей базе идут в откатываемой транзакции и ничего в ней не оставляют
- в текущем чекауте нет `.github/workflows`: CI недоступен, проверять локально
- вход на стенд идёт не через форму: сеанс выдаёт `scripts/stand-session.py`, cookie ставит `scripts/stand-cookie.py`
