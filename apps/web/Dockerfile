# Клиент v2: SvelteKit на adapter-node.
#
# Две ступени. В первой ставятся зависимости и собирается приложение, во второй
# остаётся только собранное и то, что нужно для запуска: образ со сборочными
# зависимостями весит втрое больше и держит компилятор в рантайме.

FROM node:22-alpine AS build
WORKDIR /app

# Сначала манифесты, потом исходники: слой зависимостей переживает правку кода,
# и пересборка после неё не тянет установку заново.
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Только то, что нужно на исполнение: сборка и исходники в образ не переносятся.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build

# Порт тот же, что у сервера приложения: за обратным прокси они различаются
# путями, а не портами.
EXPOSE 3000
CMD ["node", "build/index.js"]
