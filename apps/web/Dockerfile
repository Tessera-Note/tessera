# Клиент v2: SvelteKit на adapter-node.
#
# **Собирается из корня монорепозитория, а не из своего каталога.** Причина не
# в удобстве: `apps/web` зависит от `@tessera/editor-ext` записью
# `workspace:*`, а такая запись разрешается только там, где лежат
# `pnpm-workspace.yaml` и общий файл блокировки. Из своего каталога установка
# падает на первой же зависимости.
#
# Две ступени. В первой ставятся зависимости и собирается приложение, во второй
# остаётся собранное вместе с зависимостями — исходники и сборочный слой в
# готовый образ не переносятся.
#
# **Зависимости нужны на исполнение, и это проверено отказом.** Сборка
# `adapter-node` не самодостаточна: часть пакетов остаётся внешними, и отрисовка
# страницы на сервере падает с `ERR_MODULE_NOT_FOUND: @tiptap/pm`. Заметно это
# не сразу — переходы внутри приложения идут в браузере и работают, а отказ
# виден только при открытии страницы по прямой ссылке или обновлении вкладки.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable

# `.npmrc` обязателен, и это не мелочь: в нём `shamefully-hoist`, и без него
# `tsc` не оказывается на пути у пакета расширений — тот своего объявления
# TypeScript не имеет и берёт общий. Сборка падает на `tsc: not found`.
#
# Сначала манифесты, потом исходники: слой зависимостей переживает правку кода,
# и пересборка после неё не тянет установку заново.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/editor-ext/package.json ./packages/editor-ext/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --prod=false

FROM deps AS build
COPY packages ./packages
COPY apps/web ./apps/web
# Пакет расширений собирается первым: экраны берут из него типы, а сборщик
# читает их по `types` из `dist`.
RUN pnpm --filter @tessera/editor-ext build
RUN pnpm --filter @tessera/web build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Раскладка рабочего пространства сохраняется целиком: pnpm держит зависимости
# ссылками внутрь `node_modules/.pnpm`, и перенос одной только папки пакета
# оставил бы ссылки в пустоту.
#
# `package.json` нужен ещё и ради `"type": "module"`: без него Node читает
# выходные файлы как CommonJS и падает на первом же `import`.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/build ./apps/web/build

# Порт тот же, что у сервера приложения: за обратным прокси они различаются
# путями, а не портами.
EXPOSE 3000
CMD ["node", "apps/web/build/index.js"]
