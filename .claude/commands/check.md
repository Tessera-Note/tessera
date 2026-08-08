---
description: Проверка типов и сборка затронутых частей
argument-hint: [client | server | all, по умолчанию all]
---

Прогони проверку типов.

## Что запускать

Аргумент `$1` определяет объем, по умолчанию `all`.

| Аргумент | Команды |
|---|---|
| `client` | `pnpm --filter client build` (запускает `tsc`, затем сборку Vite) |
| `server` | `pnpm --filter server build` |
| `all` | `pnpm build` |

Отдельной команды `typecheck` в проекте нет, типы проверяются шагом сборки.

## Перед запуском

- если нет `node_modules`, сначала `pnpm install --frozen-lockfile`
- для изолированной сборки сервера нужен `packages/base-formula/dist`. Если каталога нет, сначала `pnpm --filter @docmost/base-formula build`. Полный `pnpm build` порядок соблюдает сам

## Как читать результат

- ошибки TypeScript обязательны к исправлению
- у клиента `strict: false` и `strictNullChecks: false`, поэтому часть проблем типами не ловится. Отсутствие ошибок не означает, что экран работает
- у сервера `strict: true`, но с отключенными `strictNullChecks`, `noImplicitAny` и `strictBindCallApply`

## После прогона

Показать сводку. При ошибках вывести первые три с путем, строкой и типом. Сам код без запроса не править, показать где проблема.
