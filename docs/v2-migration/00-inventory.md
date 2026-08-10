# Опись переносимого

Все числа получены подсчетом по коду на ветке `v2`, отделенной от `main` на
коммите `d921ba5`. Команды подсчета приведены, чтобы их можно было повторить.

## Сервер

| Что | Число |
|---|---|
| Строк production TypeScript | **66 407** |
| Строк тестов | 24 456 |
| Модулей `core` | 18 |
| Модулей `ee` | 19 |
| Модулей `integrations` | 14 |
| Контроллеров | 51 |
| Маршрутов HTTP | **248** |
| Сервисов | 81 |
| Репозиториев Kysely | 28 |
| Миграций | **62** |
| Таблиц в базе | **44** |
| Имен задач очередей | 48 |
| Процессоров очередей | 8 |
| Инструментов MCP | 65 |
| Публичных маршрутов (`@Public`) | 36 |

Группы маршрутов по префиксам: `auth`, `users`, `workspace`, `spaces`, `pages`,
`page-permissions`, `page-verification`, `comments`, `attachments`, `groups`,
`labels`, `favorites`, `templates`, `search`, `share`, `notifications`,
`bases`, `ai`, `ai/chats`, `ai/settings`, `mcp`, `api/mcp`, `pdf-export`,
`docx-export`, `import`, `export`, `scim`, `audit`, `billing`, `security`,
`sso` (`oidc`, `saml`, `ldap`, `google`), `mfa`, `api-keys`, `health`.

## Клиент

| Что | Число |
|---|---|
| Строк TypeScript и TSX | **86 633** |
| Компонентов `.tsx` | 505 |
| Страниц по маршрутам | 43 |
| Доменов `features/` | 21 |
| Файлов с атомами Jotai | 5 |
| Локалей | 12 |
| Ключей в `en-US` | **1 991** |
| Файлов, использующих Mantine | **453** |
| Представлений узлов редактора на React | **38** |
| Строк только в `features/editor` | **18 223** |

## Общие пакеты

| Пакет | Строк |
|---|---|
| `packages/editor-ext` | 13 614 |
| в том числе `prosemirror-docx` | **1 435** |
| `packages/base-formula` | 1 255 |

## Объем по узлам, которые переписываются заново

| Узел | Строк |
|---|---|
| Редактор на клиенте | 18 223 |
| Общие расширения редактора | 13 614 |
| Импорт | 3 659 |
| MCP | 3 281 |
| Bases (сервер) | 2 708 |
| Совместное редактирование | 2 480 |
| SCIM | 2 457 |
| Чат ИИ | 2 299 |
| Сериализатор DOCX | 1 435 |
| Экспорт | 1 119 |

## Итог по объему

**153 040 строк production-кода** (66 407 сервер + 86 633 клиент) плюс 14 869
строк общих пакетов, плюс 24 456 строк тестов сервера.

Это не оценка трудоемкости, это измеренный объем. Оценка в `05-phases.md`.

## Как считалось

```
find apps/server/src -name '*.ts' ! -name '*.spec.ts' -exec cat {} + | wc -l
grep -rhoE '@(Get|Post|Put|Patch|Delete)\(' apps/server/src --include=*.controller.ts | wc -l
grep -cE '^export interface [A-Z]' apps/server/src/database/types/db.d.ts
find apps/client/src \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*' -exec cat {} + | wc -l
grep -rl '@mantine/' apps/client/src | wc -l
grep -rl 'NodeViewWrapper\|ReactNodeViewRenderer' apps/client/src packages/editor-ext/src | wc -l
```
