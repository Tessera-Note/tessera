# The image of the content conversion service.
#
# Built from the root of the monorepo: the dependencies are declared there, and
# the service deliberately has no dependency file of its own — the lockfile
# belongs to the package manager, and a second set of declarations would force
# it to regenerate.
#
# A glibc base rather than Alpine. PDF parsing goes through
# `@docmost/pdf-inspector`, and that is a native module: it ships prebuilt
# binaries for glibc and none for musl. On Alpine it refuses with "Cannot find
# native binding" on the very first call.
FROM node:22-slim AS deps

WORKDIR /app
RUN corepack enable

# `.npmrc` is mandatory: it carries `shamefully-hoist`, and without it `tsc` does
# not end up on the path of the extensions package — that package has no
# TypeScript declaration of its own and takes the shared one. The build then
# fails with `tsc: not found`.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/editor-ext/package.json ./packages/editor-ext/
RUN pnpm install --frozen-lockfile --prod=false

FROM deps AS build
COPY packages ./packages
# The extensions package is built here: the service takes it built rather than
# as sources — otherwise TypeScript would have to be pulled into the image.
RUN pnpm --filter @tessera/editor-ext build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY services/collab ./services/collab

EXPOSE 3001
# `exec` is mandatory: without it the shell stays the first process, and the
# stop signal never reaches the server.
CMD ["sh", "-c", "exec node services/collab/src/server.js"]
