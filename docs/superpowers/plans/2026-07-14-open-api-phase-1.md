# Tessera Open API — Fase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Habilitar API keys no fork open source, reutilizando o token JWT, o banco e os controllers existentes.

**Architecture:** Criar o módulo open source `core/api-key`; o JWT passa a validá-lo. Os controllers de páginas e espaços permanecem inalterados.

**Tech Stack:** NestJS, Passport JWT, Kysely, PostgreSQL e Jest.

---

### Task 1: Serviço e repositório

**Files:** criar `apps/server/src/database/repos/api-key/api-key.repo.ts`, `apps/server/src/core/api-key/api-key.service.ts` e seus testes; modificar `apps/server/src/database/database.module.ts`.

- [ ] Escrever testes para chave ativa, expirada e revogada.
- [ ] Executar `pnpm --filter ./apps/server test -- core/api-key/api-key.service.spec.ts` e confirmar falha.
- [ ] Implementar no repositório `create`, `listByCreator`, `findActiveById`, `updateName`, `revoke` e `touchLastUsed`, sempre filtrando por workspace.
- [ ] Implementar no serviço a geração por `TokenService.generateApiToken`, o retorno do token somente na criação e `validateApiKey(payload)` retornando `{ user, workspace }`.
- [ ] Executar a mesma suíte e confirmar sucesso; commitar `feat: add open API key service`.

### Task 2: Rotas e autenticação

**Files:** criar `apps/server/src/core/api-key/dto/api-key.dto.ts`, `api-key.controller.ts`, `api-key.module.ts` e testes; modificar `apps/server/src/core/core.module.ts`, `apps/server/src/core/auth/auth.module.ts` e `apps/server/src/core/auth/strategies/jwt.strategy.ts`.

- [ ] Escrever testes para `POST /api/api-keys`, `/create`, `/update`, `/revoke` e para o payload JWT `type: 'api_key'`.
- [ ] Executar os testes e confirmar falha antes da implementação.
- [ ] Implementar os DTOs `CreateApiKeyDto`, `UpdateApiKeyDto` e `RevokeApiKeyDto` com validação de `name`, `expiresAt` e UUID.
- [ ] Criar controller protegido por `JwtAuthGuard` e conectar cada rota ao serviço.
- [ ] Registrar `ApiKeyModule` em `CoreModule` e `AuthModule`.
- [ ] Substituir no `JwtStrategy` o carregamento de `./../../../ee/api-key/api-key.service` por injeção direta de `ApiKeyService` e chamada `validateApiKey` para `JwtType.API_KEY`.
- [ ] Executar `pnpm --filter ./apps/server test -- core/api-key core/auth/strategies/jwt.strategy.spec.ts && pnpm nx run server:build`; commitar `feat: expose open API key endpoints`.

### Task 3: Contrato de páginas e espaços

**Files:** modificar `README.md`.

- [ ] Subir o fork com `docker compose up -d --build`.
- [ ] Criar uma chave via sessão e chamar, com Bearer token, os endpoints existentes de espaços e páginas: consulta, criação, atualização e exclusão.
- [ ] Confirmar o envelope `{ success, status, data }` e `401` após revogação.
- [ ] Documentar os exemplos e commitar `docs: document open API keys`.

## Self-review

- Reutiliza a tabela `api_keys`, `TokenService`, JWT e controllers existentes.
- Não duplica rotas ou autorização de páginas e espaços.
- Cobre gerenciamento de chaves, expiração, revogação e contrato HTTP.
