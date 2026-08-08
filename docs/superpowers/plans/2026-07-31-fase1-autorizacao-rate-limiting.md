# Fase 1 — Autorização e Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar as seis falhas de autorização que permitem a um usuário autenticado ler ou escrever conteúdo de spaces dos quais ele não participa, e aplicar rate limiting nos endpoints caros (IA, MCP, export PDF).

**Architecture:** Nenhuma abstração nova de segurança é inventada. O repositório já tem o padrão correto em três camadas — `PageAccessService.validateCanView/validateCanEdit` (permissão por página), `SpaceAbilityFactory` (CASL por space) e `SpaceMemberRepo.getUserSpaceIdsQuery` (subquery de spaces do usuário). As falhas são pontos onde esse padrão foi esquecido. Cada task leva o padrão até o ponto que ficou descoberto, com um teste unitário que falha antes e passa depois. O rate limiting reusa os throttlers nomeados que já estão registrados em Redis e nunca foram aplicados.

**Tech Stack:** NestJS 10 + Fastify, Kysely (Postgres), CASL, `@nestjs/throttler` com storage Redis, Jest (unit specs em `src/**/*.spec.ts`).

## Global Constraints

- **Nunca rode `jest` na máquina local.** Rodar a suíte localmente trava o PC do usuário. O gate de verificação local é `pnpm --filter server build`; o gate de testes é o CI (configurado na Task 1). Cada task termina com push, e o resultado do CI é o "teste passou".
- Antes de qualquer build isolado do server, garanta que `packages/base-formula/dist` existe: `pnpm --filter @tessera/base-formula build`.
- Node 22, pnpm 10.4.0. Instale com `pnpm install --frozen-lockfile`.
- `pnpm --filter server lint` roda com `--fix` e **modifica arquivos** — não use como verificação; se usar, revise o diff antes de commitar.
- Comentários de código em inglês (padrão do repositório). Mensagens de commit em inglês, no formato `fix(escopo): …` / `feat(escopo): …`, como o histórico do repo.
- Não adicione dependências novas. Tudo que este plano precisa já está no projeto.
- `CaslModule`, `PageAccessModule` e `DatabaseModule` são `@Global()` — `SpaceAbilityFactory`, `WorkspaceAbilityFactory`, `PageAccessService`, `PageRepo`, `PagePermissionRepo` e `SpaceMemberRepo` são injetáveis em qualquer módulo **sem alterar os `imports:`**. Não adicione imports de módulo desnecessários.
- Trabalhe numa branch: `git checkout -b fix/phase1-authorization`. Não commite direto em `main`.

## File Structure

**Criados:**
- `apps/server/src/ee/base/base-access.service.ts` — helpers de autorização de bases (view/edit de base, view/create em space). Espelha os helpers privados que o `McpService` já usa, agora num serviço injetável.
- `apps/server/src/ee/base/base-access.service.spec.ts`
- `apps/server/src/ee/base/base.controller.spec.ts`
- `apps/server/src/ee/search-attachments/search-attachments.service.spec.ts`
- `apps/server/src/ee/search-attachments/search-attachments.controller.spec.ts`
- `apps/server/src/ee/ai-chat/ai-chat-context.spec.ts`

**Modificados:**
- `.github/workflows/deploy.yml` — job `Validate` passa a rodar os testes; adiciona gatilho de `pull_request`.
- `apps/server/src/ee/base/base.controller.ts` — checagem de permissão em todos os 20 endpoints.
- `apps/server/src/ee/base/base.module.ts` — provider novo.
- `apps/server/src/ee/search-attachments/search-attachments.service.ts` — filtro por spaces do usuário; `triggerIndexing` sem `workspaceId` arbitrário.
- `apps/server/src/ee/search-attachments/search-attachments.controller.ts` — passa `user.id`; exige admin no indexing.
- `apps/server/src/ee/mcp/mcp.service.ts` — call site de `searchAttachmentsService.search` (2 lugares); `get_comment` valida acesso; remove o pós-filtro de embeddings que migrou para o serviço.
- `apps/server/src/ee/mcp/mcp.service.spec.ts` — caso novo para `get_comment`.
- `apps/server/src/ee/ai/ai-answers.controller.ts` — filtro por spaces do usuário.
- `apps/server/src/ee/ai-chat/ai-chat.service.ts` — valida páginas mencionadas e página de contexto.
- `apps/server/src/ee/embedding/embedding.service.ts` — filtro de permissão de página dentro do `search`.
- `apps/server/src/ee/ai/ai.controller.ts`, `ai-answers.controller.ts`, `ai-chat/ai-chat.controller.ts`, `mcp/mcp.controller.ts`, `pdf-export/pdf-export.controller.ts` — throttling.
- `apps/server/src/integrations/throttle/throttler-names.ts` — throttler novo para export.

---

### Task 1: CI executa os testes

Sem isto, todo teste escrito nas tasks seguintes é código morto — ninguém nunca os roda (jest local está vetado). Esta task é a que transforma os testes em rede de segurança de verdade.

Hoje o job `Validate` roda apenas `pnpm build`, e o workflow só dispara em push para `main` — ou seja, nada é validado antes de entrar em produção.

**Files:**
- Modify: `.github/workflows/deploy.yml:1-42` (gatilhos, concurrency, job `ci`) e os jobs `build-push`/`deploy` (guarda para não deployar em PR)

**Interfaces:**
- Consumes: nada.
- Produces: um job de CI que roda `pnpm --filter server test` e `pnpm --filter client test` em todo push para `main` e em toda PR para `main`. As tasks 2-8 dependem dele para verificar seus testes.

- [ ] **Step 1: Adicionar gatilho de PR e isolar a concurrency**

Em `.github/workflows/deploy.yml`, substitua o bloco `on:` e `concurrency:` (linhas 3-10):

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: tessera-production-${{ github.ref }}
  cancel-in-progress: false
```

O `${{ github.ref }}` no group evita que uma PR entre na fila de deploy de produção; pushes em `main` continuam serializados entre si.

- [ ] **Step 2: Rodar os testes no job Validate**

No job `ci`, logo após o step `Install dependencies`, insira:

```yaml
      - name: Server unit tests
        run: pnpm --filter server test

      - name: Client unit tests
        run: pnpm --filter client test
```

Mantenha o step `Build workspace` depois deles.

Nota: `pnpm --filter server lint` não entra aqui porque o script tem `--fix` (mutaria arquivos no CI) e o código atual tem violações preexistentes que bloqueariam tudo. Lint fica para uma fase posterior.

- [ ] **Step 3: Impedir deploy a partir de PRs**

Nos jobs `build-push` e `deploy`, adicione `if:` logo abaixo de `name:`:

```yaml
    if: github.event_name != 'pull_request'
```

Confira que ambos os jobs receberam a linha — sem isso, abrir uma PR publicaria imagem e faria deploy.

- [ ] **Step 4: Verificar**

```bash
git add .github/workflows/deploy.yml && git commit -m "ci: run unit tests and validate pull requests" && git push -u origin fix/phase1-authorization
```

Abra a PR para `main` e confirme no GitHub Actions que o job `Validate` rodou os dois steps de teste e que `build-push`/`deploy` foram pulados.

**Se algum spec existente falhar aqui, pare e conserte antes de seguir** — a suíte precisa estar verde para servir de baseline nas tasks seguintes.

---

### Task 2: Autorização nos endpoints REST de bases

`base.controller.ts:38` aplica só `JwtAuthGuard`, e `BaseService` filtra apenas por `workspaceId`. Qualquer usuário autenticado lê e escreve bases de spaces privados sabendo o `pageId`. A prova de que é bug e não decisão: o mesmo `BaseService` exposto via MCP é corretamente protegido (`mcp.service.ts:2604+`).

**Files:**
- Create: `apps/server/src/ee/base/base-access.service.ts`
- Create: `apps/server/src/ee/base/base-access.service.spec.ts`
- Create: `apps/server/src/ee/base/base.controller.spec.ts`
- Modify: `apps/server/src/ee/base/base.controller.ts` (todos os 20 handlers)
- Modify: `apps/server/src/ee/base/base.module.ts`

**Interfaces:**
- Consumes: `PageAccessService.validateCanView(page, user)` e `.validateCanEdit(page, user)`; `SpaceAbilityFactory.createForUser(user, spaceId)` (async, lança se não for membro); `PageRepo.findById(pageId, opts?)`.
- Produces: `BaseAccessService` com quatro métodos públicos:
  - `assertCanViewBase(pageId: string, user: User, workspaceId: string): Promise<Page>`
  - `assertCanEditBase(pageId: string, user: User, workspaceId: string): Promise<Page>`
  - `assertCanEditPage(pageId: string, user: User, workspaceId: string): Promise<Page>` (sem exigir `isBase` — usado por `convert`)
  - `assertCanViewSpace(spaceId: string, user: User): Promise<void>`
  - `assertCanCreateInSpace(spaceId: string, user: User): Promise<void>`

- [ ] **Step 1: Escrever o teste do BaseAccessService**

Crie `apps/server/src/ee/base/base-access.service.spec.ts`:

```ts
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BaseAccessService } from './base-access.service';

const user = { id: 'user-1' } as any;

const basePage = {
  id: 'page-1',
  spaceId: 'space-1',
  workspaceId: 'workspace-1',
  isBase: true,
  deletedAt: null,
} as any;

function build(overrides: Record<string, any> = {}) {
  const pageRepo = { findById: jest.fn().mockResolvedValue(basePage) };
  const pageAccessService = {
    validateCanView: jest.fn(),
    validateCanEdit: jest.fn(),
  };
  const spaceAbility = {
    createForUser: jest.fn().mockResolvedValue({ cannot: () => false }),
  };

  Object.assign(pageRepo, overrides.pageRepo ?? {});
  Object.assign(pageAccessService, overrides.pageAccessService ?? {});
  Object.assign(spaceAbility, overrides.spaceAbility ?? {});

  const service = new BaseAccessService(
    pageRepo as any,
    pageAccessService as any,
    spaceAbility as any,
  );

  return { service, pageRepo, pageAccessService, spaceAbility };
}

describe('BaseAccessService', () => {
  it('rejects a base the user cannot view', async () => {
    const { service } = build({
      pageAccessService: {
        validateCanView: jest.fn().mockRejectedValue(new ForbiddenException()),
      },
    });

    await expect(
      service.assertCanViewBase('page-1', user, 'workspace-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a base the user cannot edit', async () => {
    const { service } = build({
      pageAccessService: {
        validateCanEdit: jest.fn().mockRejectedValue(new ForbiddenException()),
      },
    });

    await expect(
      service.assertCanEditBase('page-1', user, 'workspace-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a page from another workspace', async () => {
    const { service } = build({
      pageRepo: {
        findById: jest
          .fn()
          .mockResolvedValue({ ...basePage, workspaceId: 'other-workspace' }),
      },
    });

    await expect(
      service.assertCanViewBase('page-1', user, 'workspace-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a page that is not a base', async () => {
    const { service } = build({
      pageRepo: {
        findById: jest.fn().mockResolvedValue({ ...basePage, isBase: false }),
      },
    });

    await expect(
      service.assertCanViewBase('page-1', user, 'workspace-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows convert on a page that is not a base yet', async () => {
    const { service, pageAccessService } = build({
      pageRepo: {
        findById: jest.fn().mockResolvedValue({ ...basePage, isBase: false }),
      },
    });

    await expect(
      service.assertCanEditPage('page-1', user, 'workspace-1'),
    ).resolves.toMatchObject({ id: 'page-1' });
    expect(pageAccessService.validateCanEdit).toHaveBeenCalled();
  });

  it('returns the page when access is granted', async () => {
    const { service, pageAccessService } = build();

    const page = await service.assertCanViewBase(
      'page-1',
      user,
      'workspace-1',
    );

    expect(page.id).toBe('page-1');
    expect(pageAccessService.validateCanView).toHaveBeenCalledWith(
      basePage,
      user,
    );
  });

  it('rejects listing bases of a space the user cannot read', async () => {
    const { service } = build({
      spaceAbility: {
        createForUser: jest.fn().mockResolvedValue({ cannot: () => true }),
      },
    });

    await expect(
      service.assertCanViewSpace('space-1', user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects creating a base in a space the user cannot write', async () => {
    const { service } = build({
      spaceAbility: {
        createForUser: jest.fn().mockResolvedValue({ cannot: () => true }),
      },
    });

    await expect(
      service.assertCanCreateInSpace('space-1', user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
```

- [ ] **Step 2: Implementar o BaseAccessService**

Crie `apps/server/src/ee/base/base-access.service.ts`:

```ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Page, User } from '@tessera/db/types/entity.types';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../core/casl/interfaces/space-ability.type';

/**
 * The REST surface for bases reached production checking only workspaceId,
 * while the same BaseService behind MCP was space-scoped. These helpers are
 * the MCP checks, extracted so both entry points enforce the same rules.
 */
@Injectable()
export class BaseAccessService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceAbility: SpaceAbilityFactory,
  ) {}

  async assertCanViewBase(
    pageId: string,
    user: User,
    workspaceId: string,
  ): Promise<Page> {
    const page = await this.getBase(pageId, workspaceId);
    await this.pageAccessService.validateCanView(page, user);
    return page;
  }

  async assertCanEditBase(
    pageId: string,
    user: User,
    workspaceId: string,
  ): Promise<Page> {
    const page = await this.getBase(pageId, workspaceId);
    await this.pageAccessService.validateCanEdit(page, user);
    return page;
  }

  /** Convert turns a regular page into a base, so isBase is not required. */
  async assertCanEditPage(
    pageId: string,
    user: User,
    workspaceId: string,
  ): Promise<Page> {
    const page = await this.getPage(pageId, workspaceId);
    await this.pageAccessService.validateCanEdit(page, user);
    return page;
  }

  async assertCanViewSpace(spaceId: string, user: User): Promise<void> {
    if (!spaceId) {
      throw new BadRequestException('spaceId is required');
    }
    // createForUser throws when the user is not a member of the space
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  async assertCanCreateInSpace(spaceId: string, user: User): Promise<void> {
    if (!spaceId) {
      throw new BadRequestException('spaceId is required');
    }
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  private async getBase(pageId: string, workspaceId: string): Promise<Page> {
    const page = await this.getPage(pageId, workspaceId);
    if (!page.isBase) {
      throw new NotFoundException('Base not found');
    }
    return page;
  }

  private async getPage(pageId: string, workspaceId: string): Promise<Page> {
    if (!pageId) {
      throw new BadRequestException('pageId is required');
    }

    const page = await this.pageRepo.findById(pageId);

    if (!page || page.deletedAt || page.workspaceId !== workspaceId) {
      throw new NotFoundException('Base not found');
    }

    return page;
  }
}
```

- [ ] **Step 3: Registrar o provider**

Substitua `apps/server/src/ee/base/base.module.ts` inteiro:

```ts
import { Module } from '@nestjs/common';
import { BaseController } from './base.controller';
import { BaseService } from './base.service';
import { BaseAccessService } from './base-access.service';

@Module({
  controllers: [BaseController],
  providers: [BaseService, BaseAccessService],
  exports: [BaseService, BaseAccessService],
})
export class BaseModule {}
```

Nenhum `imports:` novo é necessário: `PageAccessModule`, `CaslModule` e `DatabaseModule` são `@Global()`.

- [ ] **Step 4: Escrever o teste do controller**

Crie `apps/server/src/ee/base/base.controller.spec.ts`. Ele fixa o mapeamento endpoint → checagem, que é justamente o que se perdeu:

```ts
import { ForbiddenException } from '@nestjs/common';
import { BaseController } from './base.controller';

const user = { id: 'user-1' } as any;
const workspace = { id: 'workspace-1' } as any;
const page = { id: 'page-1', spaceId: 'space-1' } as any;

function build() {
  const baseService: Record<string, jest.Mock> = {
    createBase: jest.fn().mockResolvedValue({}),
    getBaseInfo: jest.fn().mockResolvedValue({}),
    updateBase: jest.fn().mockResolvedValue({}),
    deleteBase: jest.fn().mockResolvedValue({}),
    convertPageToBase: jest.fn().mockResolvedValue({}),
    exportToCsv: jest.fn().mockResolvedValue('a,b'),
    listBases: jest.fn().mockResolvedValue([]),
    createProperty: jest.fn().mockResolvedValue({}),
    updateProperty: jest.fn().mockResolvedValue({}),
    deleteProperty: jest.fn().mockResolvedValue({}),
    reorderProperty: jest.fn().mockResolvedValue({}),
    createRow: jest.fn().mockResolvedValue({}),
    getRowInfo: jest.fn().mockResolvedValue({}),
    updateRow: jest.fn().mockResolvedValue({}),
    deleteRow: jest.fn().mockResolvedValue({}),
    deleteRows: jest.fn().mockResolvedValue({}),
    listRows: jest.fn().mockResolvedValue({ items: [] }),
    reorderRow: jest.fn().mockResolvedValue({}),
    createView: jest.fn().mockResolvedValue({}),
    updateView: jest.fn().mockResolvedValue({}),
    deleteView: jest.fn().mockResolvedValue({}),
    listViews: jest.fn().mockResolvedValue([]),
  };

  const access = {
    assertCanViewBase: jest.fn().mockResolvedValue(page),
    assertCanEditBase: jest.fn().mockResolvedValue(page),
    assertCanEditPage: jest.fn().mockResolvedValue(page),
    assertCanViewSpace: jest.fn().mockResolvedValue(undefined),
    assertCanCreateInSpace: jest.fn().mockResolvedValue(undefined),
  };

  const controller = new BaseController(baseService as any, access as any);
  return { controller, baseService, access };
}

const res = { header: jest.fn(), send: jest.fn() } as any;

// [endpoint, invocação, guarda esperada]
const readEndpoints: [string, (c: BaseController) => Promise<unknown>][] = [
  ['info', (c) => c.getBaseInfo({ pageId: 'page-1' } as any, workspace)],
  [
    'rows/info',
    (c) => c.getRowInfo({ pageId: 'page-1', rowId: 'row-1' } as any, workspace),
  ],
  ['rows', (c) => c.listRows({ pageId: 'page-1' } as any, workspace)],
  ['views', (c) => c.listViews({ pageId: 'page-1' } as any, workspace)],
  [
    'export-csv',
    (c) => c.exportBaseToCsv({ pageId: 'page-1' } as any, workspace, res),
  ],
];

const writeEndpoints: [string, (c: BaseController) => Promise<unknown>][] = [
  ['update', (c) => c.updateBase({ pageId: 'page-1' } as any, workspace)],
  ['delete', (c) => c.deleteBase({ pageId: 'page-1' } as any, workspace)],
  [
    'properties/create',
    (c) => c.createProperty({ pageId: 'page-1' } as any, workspace),
  ],
  [
    'properties/update',
    (c) => c.updateProperty({ pageId: 'page-1' } as any, workspace),
  ],
  [
    'properties/delete',
    (c) =>
      c.deleteProperty(
        { pageId: 'page-1', propertyId: 'prop-1' } as any,
        workspace,
      ),
  ],
  [
    'properties/reorder',
    (c) =>
      c.reorderProperty(
        { pageId: 'page-1', propertyId: 'prop-1', position: 'a' } as any,
        workspace,
      ),
  ],
  [
    'rows/create',
    (c) => c.createRow({ pageId: 'page-1' } as any, user, workspace),
  ],
  [
    'rows/update',
    (c) =>
      c.updateRow({ pageId: 'page-1', rowId: 'row-1' } as any, user, workspace),
  ],
  [
    'rows/delete',
    (c) => c.deleteRow({ pageId: 'page-1', rowId: 'row-1' } as any, workspace),
  ],
  [
    'rows/delete-many',
    (c) =>
      c.deleteRows({ pageId: 'page-1', rowIds: ['row-1'] } as any, workspace),
  ],
  [
    'rows/reorder',
    (c) =>
      c.reorderRow(
        { pageId: 'page-1', rowId: 'row-1', position: 'a' } as any,
        workspace,
      ),
  ],
  [
    'views/create',
    (c) => c.createView({ pageId: 'page-1' } as any, user, workspace),
  ],
  [
    'views/update',
    (c) => c.updateView({ pageId: 'page-1', viewId: 'v-1' } as any, workspace),
  ],
  [
    'views/delete',
    (c) => c.deleteView({ pageId: 'page-1', viewId: 'v-1' } as any, workspace),
  ],
];

describe('BaseController authorization', () => {
  it.each(readEndpoints)(
    '%s refuses a base the user cannot view',
    async (_name, call) => {
      const { controller, access, baseService } = build();
      access.assertCanViewBase.mockRejectedValue(new ForbiddenException());

      await expect(call(controller)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      for (const fn of Object.values(baseService)) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it.each(writeEndpoints)(
    '%s refuses a base the user cannot edit',
    async (_name, call) => {
      const { controller, access, baseService } = build();
      access.assertCanEditBase.mockRejectedValue(new ForbiddenException());

      await expect(call(controller)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      for (const fn of Object.values(baseService)) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it('listBases refuses a space the user is not a member of', async () => {
    const { controller, access, baseService } = build();
    access.assertCanViewSpace.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.listBases({ spaceId: 'space-1' } as any, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(baseService.listBases).not.toHaveBeenCalled();
  });

  it('createBase checks the target space', async () => {
    const { controller, access, baseService } = build();
    access.assertCanCreateInSpace.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.createBase({ spaceId: 'space-1' } as any, user, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(baseService.createBase).not.toHaveBeenCalled();
  });

  it('createBase under a parent page checks the parent', async () => {
    const { controller, access, baseService } = build();
    access.assertCanEditPage.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.createBase(
        { parentPageId: 'parent-1' } as any,
        user,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(baseService.createBase).not.toHaveBeenCalled();
  });

  it('convert checks edit on the page being converted', async () => {
    const { controller, access, baseService } = build();
    access.assertCanEditPage.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.convertPageToBase(
        { pageId: 'page-1' } as any,
        user,
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(baseService.convertPageToBase).not.toHaveBeenCalled();
  });

  it('lets an authorized read through', async () => {
    const { controller, baseService } = build();

    await controller.getBaseInfo({ pageId: 'page-1' } as any, workspace);

    expect(baseService.getBaseInfo).toHaveBeenCalledWith(
      'page-1',
      'workspace-1',
    );
  });
});
```

- [ ] **Step 5: Aplicar as checagens no controller**

Em `apps/server/src/ee/base/base.controller.ts`, injete o serviço:

```ts
import { BaseAccessService } from './base-access.service';

// ...

  constructor(
    private readonly baseService: BaseService,
    private readonly baseAccess: BaseAccessService,
  ) {}
```

Depois insira a checagem como **primeira linha** de cada handler, conforme a tabela abaixo. Todos recebem `@AuthUser() user: User` — os handlers que hoje não têm esse parâmetro (`info`, `update`, `delete`, `export-csv`, `listBases`, todos os `properties/*`, `rows/info`, `rows/delete`, `rows/delete-many`, `rows`, `rows/reorder`, `views/update`, `views/delete`, `views`) precisam ganhá-lo.

| Handler | Linha a inserir |
| --- | --- |
| `getBaseInfo`, `exportBaseToCsv`, `getRowInfo`, `listRows`, `listViews` | `await this.baseAccess.assertCanViewBase(dto.pageId, user, workspace.id);` |
| `updateBase`, `deleteBase`, `createProperty`, `updateProperty`, `deleteProperty`, `reorderProperty`, `createRow`, `updateRow`, `deleteRow`, `deleteRows`, `reorderRow`, `createView`, `updateView`, `deleteView` | `await this.baseAccess.assertCanEditBase(dto.pageId, user, workspace.id);` |
| `convertPageToBase` | `await this.baseAccess.assertCanEditPage(dto.pageId, user, workspace.id);` |
| `listBases` | `await this.baseAccess.assertCanViewSpace(dto.spaceId, user);` |

E `createBase`, que aceita `spaceId` ou `parentPageId`:

```ts
  async createBase(
    @Body() dto: CreateBaseDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (dto.spaceId) {
      await this.baseAccess.assertCanCreateInSpace(dto.spaceId, user);
    } else if (dto.parentPageId) {
      // The service derives the space from the parent, so the parent is the
      // thing the user must be allowed to write to.
      await this.baseAccess.assertCanEditPage(
        dto.parentPageId,
        user,
        workspace.id,
      );
    } else {
      throw new BadRequestException('spaceId or parentPageId is required');
    }

    return this.baseService.createBase(dto, user.id, workspace.id);
  }
```

Adicione `BadRequestException` ao import de `@nestjs/common`.

- [ ] **Step 6: Verificar localmente**

```bash
pnpm --filter server build
```

Espera-se: build sem erros de tipo. Se `packages/base-formula/dist` não existir, rode antes `pnpm --filter @tessera/base-formula build`.

- [ ] **Step 7: Commit e verificar no CI**

```bash
git add apps/server/src/ee/base && git commit -m "fix(base): enforce space and page permissions on the REST endpoints" && git push
```

Confira na PR que os testes novos de `base-access.service.spec.ts` e `base.controller.spec.ts` passaram.

---

### Task 3: Busca de anexos vaza conteúdo de spaces privados

`search-attachments.service.ts:36` filtra só `attachments.workspaceId`, e o `select` devolve `ts_headline` com trechos do **conteúdo extraído** do anexo (linha 28). Além disso, `search-attachments.controller.ts:50-55` aceita `dto.workspaceId` arbitrário e dispara um `UPDATE` em massa em anexos de outro tenant, sem exigir admin.

O `McpService` chama esse mesmo `search` e hoje compensa filtrando depois (`mcp.service.ts:2067`). Ao mover o filtro para dentro do serviço, os dois call sites do MCP precisam passar o `userId`.

**Files:**
- Create: `apps/server/src/ee/search-attachments/search-attachments.service.spec.ts`
- Create: `apps/server/src/ee/search-attachments/search-attachments.controller.spec.ts`
- Modify: `apps/server/src/ee/search-attachments/search-attachments.service.ts:10-87`
- Modify: `apps/server/src/ee/search-attachments/search-attachments.controller.ts:38-56`
- Modify: `apps/server/src/ee/mcp/mcp.service.ts:2068` e `:2924`

**Interfaces:**
- Consumes: `SpaceMemberRepo.getUserSpaceIdsQuery(userId)` — subquery Kysely usável direto em `.where(col, 'in', subquery)`; `WorkspaceAbilityFactory.createForUser(user, workspace)` (**síncrono**, sem `await`).
- Produces: `SearchAttachmentsService.search(queryText, workspaceId, userId, spaceId?)` — nova assinatura, `userId` obrigatório na 3ª posição. `triggerIndexing(workspaceId)` inalterado, mas só alcançável por admin.

- [ ] **Step 1: Escrever o teste do serviço**

Crie `apps/server/src/ee/search-attachments/search-attachments.service.spec.ts`:

```ts
import { SearchAttachmentsService } from './search-attachments.service';

describe('SearchAttachmentsService', () => {
  function build() {
    const where = jest.fn();
    const query: any = {
      innerJoin: jest.fn(() => query),
      select: jest.fn(() => query),
      where: jest.fn((...args: unknown[]) => {
        where(...args);
        return query;
      }),
      orderBy: jest.fn(() => query),
      limit: jest.fn(() => query),
      execute: jest.fn().mockResolvedValue([]),
    };

    const db = { selectFrom: jest.fn(() => query) };
    const spaceMemberRepo = {
      getUserSpaceIdsQuery: jest.fn().mockReturnValue('SPACE_SUBQUERY'),
    };

    const service = new SearchAttachmentsService(
      db as any,
      spaceMemberRepo as any,
    );

    return { service, where, spaceMemberRepo };
  }

  it('restricts the search to spaces the user belongs to', async () => {
    const { service, where, spaceMemberRepo } = build();

    await service.search('runbook', 'workspace-1', 'user-1');

    expect(spaceMemberRepo.getUserSpaceIdsQuery).toHaveBeenCalledWith('user-1');
    expect(where).toHaveBeenCalledWith(
      'attachments.spaceId',
      'in',
      'SPACE_SUBQUERY',
    );
  });

  it('still applies the space filter when a spaceId is supplied', async () => {
    const { service, where } = build();

    await service.search('runbook', 'workspace-1', 'user-1', 'space-9');

    expect(where).toHaveBeenCalledWith(
      'attachments.spaceId',
      'in',
      'SPACE_SUBQUERY',
    );
    expect(where).toHaveBeenCalledWith('attachments.spaceId', '=', 'space-9');
  });

  it('returns nothing for an empty query without touching the database', async () => {
    const { service, where } = build();

    await expect(service.search('   ', 'workspace-1', 'user-1')).resolves.toEqual(
      { items: [] },
    );
    expect(where).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Aplicar o filtro no serviço**

Em `apps/server/src/ee/search-attachments/search-attachments.service.ts`, adicione o import e a dependência:

```ts
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';

// ...

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceMemberRepo: SpaceMemberRepo,
  ) {}
```

Mude a assinatura e acrescente o filtro logo após o `.where('attachments.workspaceId', '=', workspaceId)`:

```ts
  async search(
    queryText: string,
    workspaceId: string,
    userId: string,
    spaceId?: string,
  ) {
```

```ts
      .where('attachments.workspaceId', '=', workspaceId)
      // Attachment rows carry the extracted document text in the highlight, so
      // this must be scoped to the user's spaces exactly like SearchService.
      .where(
        'attachments.spaceId',
        'in',
        this.spaceMemberRepo.getUserSpaceIdsQuery(userId),
      )
      .where('attachments.deletedAt', 'is', null)
```

- [ ] **Step 3: Escrever o teste do controller**

Crie `apps/server/src/ee/search-attachments/search-attachments.controller.spec.ts`:

```ts
import { ForbiddenException } from '@nestjs/common';
import { SearchAttachmentsController } from './search-attachments.controller';

const user = { id: 'user-1' } as any;
const workspace = { id: 'workspace-1' } as any;

function build(canManage = true) {
  const searchService = {
    search: jest.fn().mockResolvedValue({ items: [] }),
    triggerIndexing: jest.fn().mockResolvedValue({ success: true }),
  };
  const workspaceAbility = {
    createForUser: jest.fn().mockReturnValue({ cannot: () => !canManage }),
  };

  const controller = new SearchAttachmentsController(
    searchService as any,
    workspaceAbility as any,
  );

  return { controller, searchService };
}

describe('SearchAttachmentsController', () => {
  it('passes the caller id down to the search', async () => {
    const { controller, searchService } = build();

    await controller.search({ query: 'nota' } as any, user, workspace);

    expect(searchService.search).toHaveBeenCalledWith(
      'nota',
      'workspace-1',
      'user-1',
      undefined,
    );
  });

  it('refuses indexing for a non-admin', async () => {
    const { controller, searchService } = build(false);

    await expect(
      controller.triggerIndexing(user, workspace),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(searchService.triggerIndexing).not.toHaveBeenCalled();
  });

  it('indexes only the caller workspace', async () => {
    const { controller, searchService } = build();

    await controller.triggerIndexing(user, workspace);

    expect(searchService.triggerIndexing).toHaveBeenCalledWith('workspace-1');
  });
});
```

- [ ] **Step 4: Corrigir o controller**

Em `apps/server/src/ee/search-attachments/search-attachments.controller.ts`:

Acrescente os imports e a dependência:

```ts
import { ForbiddenException } from '@nestjs/common';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';

// ...

  constructor(
    private readonly searchService: SearchAttachmentsService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}
```

Remova a classe `IndexAttachmentsDto` inteira (ela só existia para aceitar o `workspaceId` arbitrário) e substitua os dois handlers:

```ts
  @HttpCode(HttpStatus.OK)
  @Post()
  async search(
    @Body() dto: SearchAttachmentsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.searchService.search(
      dto.query,
      workspace.id,
      user.id,
      dto.spaceId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('indexing')
  async triggerIndexing(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }

    // The workspace comes from the session, never from the body.
    return this.searchService.triggerIndexing(workspace.id);
  }
```

- [ ] **Step 5: Atualizar os dois call sites do MCP**

Em `apps/server/src/ee/mcp/mcp.service.ts:2068`:

```ts
        const { items } = await this.searchAttachmentsService.search(
          args.query,
          workspace.id,
          user.id,
          args.spaceId,
        );
```

E em `apps/server/src/ee/mcp/mcp.service.ts:2924` (dentro de `sweepComments`/`sweep` de anexos), o mesmo acréscimo de `user.id` na terceira posição. Confirme que a função tem `user` em escopo; se receber `userId`, use-o.

Os pós-filtros de space que já existem no MCP podem ficar — são redundantes agora, mas inofensivos, e removê-los invalidaria testes existentes.

- [ ] **Step 6: Verificar localmente**

```bash
pnpm --filter server build
```

Espera-se: build limpo. Um erro de aridade aqui significa call site do `search` esquecido — procure com `grep -rn "searchAttachmentsService.search" apps/server/src`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/ee/search-attachments apps/server/src/ee/mcp/mcp.service.ts && git commit -m "fix(search-attachments): scope results to the caller spaces and gate indexing to admins" && git push
```

---

### Task 4: `/ai/answers` responde sobre spaces que o usuário não vê

`ai-answers.controller.ts:81-95` busca páginas filtrando só `workspaceId` e `deletedAt`, e devolve `excerpt` (linha 116) mais a resposta gerada. O caminho equivalente no chat já faz certo (`ai-chat.service.ts:605`).

**Files:**
- Modify: `apps/server/src/ee/ai/ai-answers.controller.ts` (constructor, `searchQuery`)

**Interfaces:**
- Consumes: `SpaceMemberRepo.getUserSpaceIdsQuery(userId)`.
- Produces: nada consumido por outras tasks.

- [ ] **Step 1: Injetar o repositório**

Em `apps/server/src/ee/ai/ai-answers.controller.ts`, adicione o import e a dependência no constructor (que hoje tem `db`, `providerFactory`, `environmentService`):

```ts
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';

// ...

    private readonly spaceMemberRepo: SpaceMemberRepo,
```

- [ ] **Step 2: Filtrar a busca**

Localize o `searchQuery` (por volta da linha 81) e acrescente o filtro de spaces:

```ts
      let searchQuery = this.db
        .selectFrom('pages')
        .select(['id', 'title', 'slugId', 'content'])
        .where('workspaceId', '=', workspace.id)
        // Answers quote page excerpts back to the caller, so the candidate set
        // has to be the caller's spaces — not the whole workspace.
        .where(
          'spaceId',
          'in',
          this.spaceMemberRepo.getUserSpaceIdsQuery(user.id),
        )
        .where('deletedAt', 'is', null)
        .where(
          sql<boolean>`tsv @@ to_tsquery('english', f_unaccent(${searchTerms}))`,
        )
        .limit(5);
```

O parâmetro `user` já existe na assinatura do handler (`@AuthUser() user: User`), então não há mudança de assinatura.

- [ ] **Step 3: Verificar localmente**

```bash
pnpm --filter server build
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/ee/ai/ai-answers.controller.ts && git commit -m "fix(ai): scope /ai/answers retrieval to the caller spaces" && git push
```

---

### Task 5: Chat de IA aceita IDs de páginas arbitrários

`ai-chat.service.ts:304-316` (`mentionedPageIds`) e `:318-329` (`contextPageId`) carregam páginas filtrando apenas por `workspaceId`, e injetam o conteúdo no prompt. Um usuário pode mandar IDs de páginas restritas e receber o conteúdo de volta na resposta do modelo. A autorização existe só na escrita (`authorizeEdit`, `:704`).

**Files:**
- Create: `apps/server/src/ee/ai-chat/ai-chat-context.spec.ts`
- Modify: `apps/server/src/ee/ai-chat/ai-chat.service.ts:302-330`

**Interfaces:**
- Consumes: `PageAccessService.validateCanView(page, user)`. O `AiChatService` **já injeta** `pageAccessService` (5º parâmetro do constructor, usado em `authorizeEdit`) e `AiChatModule` já importa `PageAccessModule` — nenhuma mudança de wiring é necessária.
- O método que contém os dois blocos é `async *sendMessage(params, user: User, workspaceId: string)` (`ai-chat.service.ts:238`). O objeto `user` **já está em escopo**; não mude assinaturas.
- Produces: método privado `filterViewablePages(pages, user)` no `AiChatService`.

- [ ] **Step 1: Escrever o teste**

Crie `apps/server/src/ee/ai-chat/ai-chat-context.spec.ts`. Ele testa o helper isoladamente, sem montar o serviço inteiro:

```ts
import { ForbiddenException } from '@nestjs/common';
import { AiChatService } from './ai-chat.service';

const user = { id: 'user-1' } as any;

const pageA = { id: 'page-a', title: 'A', content: {} } as any;
const pageB = { id: 'page-b', title: 'B', content: {} } as any;

describe('AiChatService.filterViewablePages', () => {
  function build(validateCanView: jest.Mock) {
    // Only pageAccessService is exercised here; the helper touches nothing else.
    const service = Object.create(AiChatService.prototype) as AiChatService;
    (service as any).pageAccessService = { validateCanView };
    return service;
  }

  it('drops pages the user cannot view', async () => {
    const validateCanView = jest.fn(async (page: any) => {
      if (page.id === 'page-b') throw new ForbiddenException();
    });
    const service = build(validateCanView);

    const result = await (service as any).filterViewablePages(
      [pageA, pageB],
      user,
    );

    expect(result.map((p: any) => p.id)).toEqual(['page-a']);
  });

  it('keeps every page the user can view', async () => {
    const service = build(jest.fn());

    const result = await (service as any).filterViewablePages(
      [pageA, pageB],
      user,
    );

    expect(result).toHaveLength(2);
  });

  it('returns an empty list when nothing is viewable', async () => {
    const service = build(
      jest.fn().mockRejectedValue(new ForbiddenException()),
    );

    const result = await (service as any).filterViewablePages(
      [pageA, pageB],
      user,
    );

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Implementar o helper**

Em `apps/server/src/ee/ai-chat/ai-chat.service.ts`, adicione o método privado junto aos outros helpers privados (perto de `extractTextFromContent`):

```ts
  /**
   * Mentions and the context page arrive as raw ids from the client. Without
   * this the model would happily quote a restricted page back to the caller.
   */
  private async filterViewablePages<T extends { id: string }>(
    pages: T[],
    user: User,
  ): Promise<T[]> {
    const checked = await Promise.all(
      pages.map(async (page) => {
        try {
          await this.pageAccessService.validateCanView(page as any, user);
          return page;
        } catch {
          return null;
        }
      }),
    );

    return checked.filter((page): page is T => page !== null);
  }
```

`validateCanView` precisa de `spaceId` no objeto da página, então as consultas do próximo step têm que selecioná-lo.

- [ ] **Step 3: Filtrar as páginas mencionadas**

Substitua o bloco de `mentionedPageIds` (`ai-chat.service.ts:302-316`):

```ts
    // Build context from mentioned pages
    let contextText = '';
    if (params.mentionedPageIds?.length) {
      const mentioned = await this.db
        .selectFrom('pages')
        .select(['id', 'spaceId', 'title', 'content'])
        .where('id', 'in', params.mentionedPageIds)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .execute();

      const pages = await this.filterViewablePages(mentioned, user);

      if (pages.length > 0) {
        contextText = pages
          .map((p) => `## ${p.title}\n${this.extractTextFromContent(p.content)}`)
          .join('\n\n');
      }
    }
```

- [ ] **Step 4: Filtrar a página de contexto**

Substitua o bloco de `contextPageId` (`ai-chat.service.ts:318-330`):

```ts
    if (params.contextPageId) {
      const page = await this.db
        .selectFrom('pages')
        .select(['id', 'spaceId', 'title', 'content'])
        .where('id', '=', params.contextPageId)
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();

      const [viewable] = page
        ? await this.filterViewablePages([page], user)
        : [];

      if (viewable) {
        contextText += `\n\n## Current page (ID: ${viewable.id}, Title: ${viewable.title}):\n${this.extractTextFromContent(viewable.content)}`;
      }
    }
```

- [ ] **Step 5: Verificar localmente**

```bash
pnpm --filter server build
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ee/ai-chat && git commit -m "fix(ai): validate read access on mentioned and context pages" && git push
```

---

### Task 6: MCP `get_comment` não valida acesso à página

`mcp.service.ts:1531-1538` devolve o comentário sem `validateCanView`. Todas as outras tools de comentário validam (`:1522`, `:1540`, `:1573`, `:1595`), e `getCommentInWorkspace` já devolve a página junto — só falta usá-la.

**Files:**
- Modify: `apps/server/src/ee/mcp/mcp.service.ts:1531-1538`
- Modify: `apps/server/src/ee/mcp/mcp.service.spec.ts` (caso novo)

**Interfaces:**
- Consumes: `getCommentInWorkspace(commentId, workspace)` → `{ comment, page }`; `pageAccessService.validateCanView(page, user)`.
- Produces: nada.

- [ ] **Step 1: Escrever o teste**

Em `apps/server/src/ee/mcp/mcp.service.spec.ts`, dentro do `describe('McpService permissions')`, acrescente:

```ts
  it('get_comment rejects a comment on a page the user cannot view', async () => {
    const comment = {
      id: 'comment-1',
      pageId: 'page-1',
      workspaceId: 'workspace-1',
    };
    const { service, deps } = buildService({
      commentRepo: { findById: jest.fn().mockResolvedValue(comment) },
    });
    deps.pageAccessService.validateCanView.mockRejectedValue(
      new ForbiddenException(),
    );

    const response: any = await callTool(service, 'get_comment', {
      commentId: 'comment-1',
    });

    expect(response.result.isError).toBe(true);
  });
```

Nota: o `buildService` monta as deps por posição a partir de um array de nomes. `commentRepo` já está lá — passe o override pelo parâmetro, como no exemplo, sem mexer no array.

Erros de tool viram `result.isError` em vez de exceção (ver `toToolErrorMessage`, `mcp.service.ts:213`), por isso a asserção é sobre `isError` e não `rejects`.

- [ ] **Step 2: Implementar**

Substitua o case em `apps/server/src/ee/mcp/mcp.service.ts:1531`:

```ts
      case 'get_comment': {
        const { comment, page } = await this.getCommentInWorkspace(
          args.commentId,
          workspace,
        );
        await this.pageAccessService.validateCanView(page, user);
        return comment;
      }
```

- [ ] **Step 3: Verificar localmente**

```bash
pnpm --filter server build
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/ee/mcp && git commit -m "fix(mcp): validate page access before returning a comment" && git push
```

---

### Task 7: Busca semântica ignora restrições de página

`embedding.service.ts:168-227` filtra por `spaceIds` mas não por permissão de página. O MCP compensa com um pós-filtro (`mcp.service.ts:2391-2404`, que inclusive documenta o porquê), mas o chat de IA (`ai-chat.service.ts:611-626`) consome o mesmo `search` sem esse pós-filtro — páginas restritas dentro de um space vazam como contexto. O filtro pertence ao serviço, não aos call sites.

**Files:**
- Modify: `apps/server/src/ee/embedding/embedding.service.ts` (constructor e `search`)
- Modify: `apps/server/src/ee/mcp/mcp.service.ts:2382-2404` (remover o pós-filtro que virou redundante)

**Interfaces:**
- Consumes: `PagePermissionRepo.filterAccessiblePageIds({ pageIds, userId, spaceId? }): Promise<string[]>` (import `@tessera/db/repos/page/page-permission.repo`).
- Produces: `EmbeddingService.search` ganha o campo obrigatório `userId: string` no objeto de opções. Call sites: `mcp.service.ts` (semantic search) e `ai-chat.service.ts:611`.

- [ ] **Step 1: Escrever o teste**

Crie `apps/server/src/ee/embedding/embedding.service.spec.ts`:

```ts
import { EmbeddingService } from './embedding.service';

describe('EmbeddingService.search', () => {
  it('drops hits the user cannot read', async () => {
    const rows = [
      {
        pageId: 'page-a',
        chunkIndex: 0,
        chunkStart: 0,
        chunkLength: 10,
        title: 'A',
        slugId: 'a',
        spaceId: 'space-1',
        textContent: 'alpha text',
        similarity: 0.9,
      },
      {
        pageId: 'page-b',
        chunkIndex: 0,
        chunkStart: 0,
        chunkLength: 10,
        title: 'B',
        slugId: 'b',
        spaceId: 'space-1',
        textContent: 'beta text',
        similarity: 0.8,
      },
    ];

    const query: any = {
      innerJoin: jest.fn(() => query),
      select: jest.fn(() => query),
      where: jest.fn(() => query),
      orderBy: jest.fn(() => query),
      limit: jest.fn(() => query),
      execute: jest.fn().mockResolvedValue(rows),
    };

    const service = Object.create(EmbeddingService.prototype) as any;
    service.db = { selectFrom: jest.fn(() => query) };
    service.pagePermissionRepo = {
      filterAccessiblePageIds: jest.fn().mockResolvedValue(['page-a']),
    };
    service.embeddingModel = jest.fn().mockResolvedValue({});
    service.providerOptions = jest.fn().mockResolvedValue({});
    service.embedQuery = jest.fn().mockResolvedValue([0.1, 0.2]);

    const results = await service.search({
      query: 'alpha',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      spaceIds: ['space-1'],
      limit: 5,
    });

    expect(results.map((r: any) => r.pageId)).toEqual(['page-a']);
    expect(
      service.pagePermissionRepo.filterAccessiblePageIds,
    ).toHaveBeenCalledWith({
      pageIds: ['page-a', 'page-b'],
      userId: 'user-1',
    });
  });

  it('returns nothing when the user has no spaces', async () => {
    const service = Object.create(EmbeddingService.prototype) as any;

    await expect(
      service.search({
        query: 'x',
        workspaceId: 'workspace-1',
        userId: 'user-1',
        spaceIds: [],
        limit: 5,
      }),
    ).resolves.toEqual([]);
  });
});
```

O teste chama `service.embedQuery`, um método que ainda não existe — extraí-lo é o próximo step. Isso mantém o teste livre do SDK de embeddings.

- [ ] **Step 2: Extrair `embedQuery` e injetar o repositório**

Em `apps/server/src/ee/embedding/embedding.service.ts`, adicione o import e a dependência:

```ts
import { PagePermissionRepo } from '@tessera/db/repos/page/page-permission.repo';
```

Acrescente `private readonly pagePermissionRepo: PagePermissionRepo,` ao constructor.

Extraia a chamada de embedding para um método privado:

```ts
  private async embedQuery(
    query: string,
    workspaceId: string,
  ): Promise<number[]> {
    const { embedding } = await embed({
      model: await this.embeddingModel(workspaceId),
      value: query,
      providerOptions: await this.providerOptions(workspaceId),
    });
    return embedding;
  }
```

- [ ] **Step 3: Aplicar o filtro dentro do `search`**

Substitua o corpo de `search` a partir da assinatura:

```ts
  async search(opts: {
    query: string;
    workspaceId: string;
    userId: string;
    spaceIds: string[];
    limit: number;
  }) {
    const { query, workspaceId, userId, spaceIds, limit } = opts;

    if (spaceIds.length === 0) return [];

    const embedding = await this.embedQuery(query, workspaceId);
    const vector = sql`${JSON.stringify(embedding)}::vector`;
```

O bloco de `rows` continua igual. Depois de montar `bestPerPage`, insira o filtro antes do `map` final:

```ts
    const bestPerPage = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!bestPerPage.has(row.pageId)) bestPerPage.set(row.pageId, row);
    }

    const candidates = [...bestPerPage.values()];

    // Vector distance ignores page-level restrictions. Filtering here rather
    // than at each call site is deliberate: the AI chat used to skip it.
    const accessible = new Set(
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds: candidates.map((row) => row.pageId),
        userId,
      }),
    );

    return candidates
      .filter((row) => accessible.has(row.pageId))
      .map((row) => ({
        pageId: row.pageId,
        slugId: row.slugId,
        title: row.title,
        spaceId: row.spaceId,
        similarity: Number(row.similarity.toFixed(4)),
        excerpt: (row.textContent || '')
          .slice(row.chunkStart, row.chunkStart + row.chunkLength)
          .trim()
          .slice(0, 400),
      }));
  }
```

- [ ] **Step 4: Atualizar os call sites**

Em `apps/server/src/ee/ai-chat/ai-chat.service.ts:611`, dentro de `retrieveWikiContext` — que já desestrutura `userId` de `opts` na linha 600 — acrescente `userId,` (shorthand) ao objeto:

```ts
        const hits = await this.embeddingService.search({
          query: trimmed,
          workspaceId,
          userId,
          spaceIds,
          limit: RETRIEVAL_LIMIT + exclude.size,
        });
```

Em `apps/server/src/ee/mcp/mcp.service.ts:2382`, acrescente `userId: user.id,` e **remova** o bloco de pós-filtro `accessible` (linhas ~2391-2398), passando a filtrar só por `minSimilarity`:

```ts
        const hits = await this.embeddingService.search({
          query: args.query,
          workspaceId: workspace.id,
          userId: user.id,
          spaceIds,
          limit,
        });

        const results = hits
          .filter((hit) => hit.similarity >= minSimilarity)
          .slice(0, limit);
```

Atenção: `mcp.service.spec.ts` pode ter um caso que verifica o pós-filtro via `pagePermissionRepo.filterAccessiblePageIds`. Se algum teste quebrar no CI, ajuste-o para mockar `embeddingService.search` retornando já filtrado — o comportamento observável da tool não muda.

- [ ] **Step 5: Verificar localmente**

```bash
pnpm --filter server build
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ee/embedding apps/server/src/ee/mcp/mcp.service.ts apps/server/src/ee/ai-chat/ai-chat.service.ts && git commit -m "fix(ai): enforce page permissions inside semantic search" && git push
```

---

### Task 8: Rate limiting nos endpoints caros

`AI_CHAT_THROTTLER` está registrado com 25 req/min em Redis (`throttle.module.ts:20`) e `UserThrottlerGuard` existe, mas a única referência fora do módulo é o `@SkipThrottle` em `auth.controller.ts:41`. Na prática: zero rate limiting em `/ai/generate`, `/ai/generate/stream`, `/ai/answers`, `/ai/chats/send`, `/api/mcp` e `/pdf-export/page`.

O padrão a seguir é o do `AuthController`: `@UseGuards(...)` no controller mais `@SkipThrottle` para os throttlers nomeados que não se aplicam — com `ThrottlerGuard`, **todos** os throttlers registrados valem, a menos que sejam explicitamente pulados.

**Files:**
- Modify: `apps/server/src/integrations/throttle/throttler-names.ts`
- Modify: `apps/server/src/integrations/throttle/throttle.module.ts:18-21`
- Modify: `apps/server/src/ee/ai/ai.controller.ts:17`
- Modify: `apps/server/src/ee/ai/ai-answers.controller.ts:21`
- Modify: `apps/server/src/ee/ai-chat/ai-chat.controller.ts:17`
- Modify: `apps/server/src/ee/mcp/mcp.controller.ts:18`
- Modify: `apps/server/src/ee/pdf-export/pdf-export.controller.ts:24`

**Interfaces:**
- Consumes: `UserThrottlerGuard` (rastreia por `user:<id>`, com fallback para IP), `AUTH_THROTTLER`, `AI_CHAT_THROTTLER`.
- Produces: `EXPORT_THROTTLER = 'export'`, 10 req/min.

- [ ] **Step 1: Registrar o throttler de export**

Em `apps/server/src/integrations/throttle/throttler-names.ts`:

```ts
export const AUTH_THROTTLER = 'auth';
export const AI_CHAT_THROTTLER = 'ai-chat';
export const EXPORT_THROTTLER = 'export';
```

Em `apps/server/src/integrations/throttle/throttle.module.ts`, adicione ao array `throttlers` e ao import:

```ts
import {
  AUTH_THROTTLER,
  AI_CHAT_THROTTLER,
  EXPORT_THROTTLER,
} from './throttler-names';
```

```ts
          throttlers: [
            { name: AUTH_THROTTLER, ttl: 60_000, limit: 10 },
            { name: AI_CHAT_THROTTLER, ttl: 60_000, limit: 25 },
            { name: EXPORT_THROTTLER, ttl: 60_000, limit: 10 },
          ],
```

- [ ] **Step 2: Proteger os três controllers de IA**

Em cada um de `ai.controller.ts`, `ai-answers.controller.ts` e `ai-chat.controller.ts`, adicione os imports:

```ts
import { SkipThrottle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';
import {
  AUTH_THROTTLER,
  EXPORT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
```

(em `ai-chat.controller.ts` o prefixo é `../../integrations/...` também — confirme a profundidade do caminho ao salvar)

E os decorators acima do `@Controller(...)`, mantendo o `@UseGuards(JwtAuthGuard)` existente:

```ts
@SkipThrottle({ [AUTH_THROTTLER]: true, [EXPORT_THROTTLER]: true })
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
@Controller('ai')
```

A ordem importa: `JwtAuthGuard` primeiro, para que `req.user` exista quando `UserThrottlerGuard.getTracker` rodar — é o que faz o limite ser por usuário e não por IP.

- [ ] **Step 3: Proteger o endpoint MCP**

Em `apps/server/src/ee/mcp/mcp.controller.ts`, no handler `handleMcpRpc` (não no controller inteiro, para não limitar o `@Get()` informativo):

```ts
  @Post()
  @SkipThrottle({ [AUTH_THROTTLER]: true, [EXPORT_THROTTLER]: true })
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @SkipTransform()
  async handleMcpRpc(
```

Com os mesmos imports do step anterior (caminho `../../integrations/...`).

25 req/min é apertado para um agente autônomo em loop. Se na prática atrapalhar, o ajuste é criar um `MCP_THROTTLER` próprio com limite maior — não remover o guard.

- [ ] **Step 4: Proteger o export de PDF**

Em `apps/server/src/ee/pdf-export/pdf-export.controller.ts`, apenas no handler `exportPage` (o `render` é `@Public()` e é chamado pelo Gotenberg — não pode ser limitado por usuário):

```ts
  @SkipThrottle({ [AUTH_THROTTLER]: true, [AI_CHAT_THROTTLER]: true })
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @Post('page')
  async exportPage(
```

Import correspondente:

```ts
import { SkipThrottle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../../integrations/throttle/user-throttler.guard';
import {
  AUTH_THROTTLER,
  AI_CHAT_THROTTLER,
} from '../../integrations/throttle/throttler-names';
```

- [ ] **Step 5: Verificar localmente**

```bash
pnpm --filter server build
```

- [ ] **Step 6: Verificação manual em runtime**

Rate limiting não é coberto por teste unitário aqui (exigiria Redis). Suba o ambiente local e confirme o 429:

```bash
pnpm dev
```

Com uma sessão válida, dispare 30 chamadas seguidas a `/api/ai/answers` e confirme que as últimas retornam HTTP 429 com `Too many requests`. Confirme também que o login continua funcionando (o `AUTH_THROTTLER` não deve ter sido afetado).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/integrations/throttle apps/server/src/ee && git commit -m "feat(security): rate limit the AI, MCP and PDF export endpoints" && git push
```

---

## Fechamento da fase

- [ ] **Confirmar CI verde** na PR, com os specs novos aparecendo na saída do job `Validate`.
- [ ] **Atualizar a documentação de contexto**: `docs/ai-context/enterprise-security.md` e `docs/ai-context/mcp.md` descrevem o modelo de permissões — registre que o REST de bases, a busca de anexos, `/ai/answers`, o contexto do chat e a busca semântica passaram a ser space/page-scoped, e que os endpoints de IA/MCP/PDF têm throttling.
- [ ] **Merge** e acompanhar o deploy.

### O que esta fase deliberadamente NÃO resolve

Fica registrado para não parecer esquecimento — são itens das fases seguintes:

- `restrictApiToAdmins`, `mcpEnabled` e `workspace.settings.ai.*` continuam sendo configuração morta (nenhum guard os lê).
- API keys continuam sem escopo: uma chave é impersonação total do usuário.
- Prompt injection indireta via conteúdo de página recuperado continua possível.
- `listRows` continua sem `LIMIT` no SQL (regressão de performance do commit `2092ff1f`).
- A questão de licenciamento EE (bypass de licença + `LICENSE` removidos) é decisão de negócio, tratada fora deste plano.
