# Образ сервиса преобразования содержимого.
#
# Собирается из корня монорепозитория: зависимости объявлены там, и своего
# файла зависимостей у сервиса нет намеренно — файл блокировки принадлежит
# пакетному менеджеру, и второй набор объявлений заставил бы его
# перегенерировать.
#
# База с glibc, а не Alpine. Разбор PDF идёт через `@docmost/pdf-inspector`,
# и это природный модуль: собранные бинарники в нём есть под glibc, под musl —
# нет. На Alpine он отказывает «Cannot find native binding» при первом же
# обращении. Тот же образ у первой версии, и по той же причине.
FROM node:22-slim AS deps

WORKDIR /app
RUN corepack enable

# `.npmrc` обязателен: в нём `shamefully-hoist`, и без него `tsc` не оказывается
# на пути у пакета расширений — своего объявления TypeScript тот не имеет и
# берёт общий. Сборка падает на `tsc: not found`.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/editor-ext/package.json ./packages/editor-ext/
COPY apps/client/package.json ./apps/client/
COPY apps/server/package.json ./apps/server/
RUN pnpm install --frozen-lockfile --prod=false

FROM deps AS build
COPY packages ./packages
# Пакет расширений собирается: сервис берёт его собранным, а не исходниками —
# иначе в образ пришлось бы тянуть TypeScript.
RUN pnpm --filter @tessera/editor-ext build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY services/collab ./services/collab

EXPOSE 3001
# `exec` обязателен: без него первым процессом остаётся оболочка, и сигнал
# остановки до сервера не доходит.
CMD ["sh", "-c", "exec node services/collab/src/server.js"]
