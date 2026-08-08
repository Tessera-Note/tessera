---
description: Production сборка
argument-hint: [all | client | server, по умолчанию all]
---

Собери проект.

## Команды

| Аргумент | Команда | Результат |
|---|---|---|
| `all` | `pnpm build` | `nx run-many -t build`, порядок зависимостей соблюдается |
| `client` | `pnpm --filter client build` | `tsc`, затем сборка Vite в `apps/client/dist` |
| `server` | `pnpm --filter server build` | `nest build` в `apps/server/dist` |

## Порядок зависимостей

Изолированной сборке сервера нужен `packages/base-formula/dist`, оттуда резолвятся объявления типов. Если каталога нет, сначала:

```
pnpm --filter @docmost/base-formula build
```

Полный `pnpm build` этот порядок обеспечивает сам через `targetDefaults.build.dependsOn` в `nx.json`. Результаты сборки кешируются Nx.

## Если сборка упала

Прочитать вывод и показать пользователю, не чиня молча. Частые причины.

- отсутствует `packages/base-formula/dist` при изолированной сборке сервера
- не установлены зависимости, нужен `pnpm install --frozen-lockfile`
- ошибка типов после правки DTO или сущностей базы, при этом `db.d.ts` не перегенерирован
- новый алиас добавлен в `apps/server/tsconfig.json`, но не продублирован в `moduleNameMapper` внутри `apps/server/package.json`

## После сборки

Показать итоговые размеры чанков клиента из вывода Vite. Маршруты подключаются через `React.lazy`, а Mantine вынесен в отдельную группу `vendor-mantine`. Если размер основного чанка внезапно вырос, проверить, не попал ли редактор или история страницы обратно в него: они намеренно отложены до момента, когда данные страницы разрешились.

Артефакт `apps/client/dist` нужен серверу: `StaticModule` отдает SPA только при его наличии и подставляет в `index.html` конфигурацию времени выполнения.
