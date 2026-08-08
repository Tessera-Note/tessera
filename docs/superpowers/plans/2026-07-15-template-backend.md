# Template Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the complete authenticated template backend expected by the existing Tessera 0.95.0 frontend.

**Architecture:** Add a focused NestJS `TemplateModule` under the local EE tree. Its controller exposes the six existing client routes; its service owns workspace/space authorization and composes the existing repositories plus `PageService` for page creation.

**Tech Stack:** NestJS 11, TypeScript 5.9, class-validator, Jest 30, Kysely/PostgreSQL.

---

### Task 1: DTO contract and validation

**Files:**
- Create: `apps/server/src/ee/template/dto/template.dto.ts`
- Create: `apps/server/src/ee/template/dto/template.dto.spec.ts`

- [ ] **Step 1: Write failing DTO tests**

Use `validate()` from `class-validator` and `plainToInstance()` from `class-transformer` to assert that UUID fields, required trimmed titles, pagination limits, mutable update fields, and optional ProseMirror JSON are accepted or rejected according to the approved contract.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter server test -- --runInBand ee/template/dto/template.dto.spec.ts`

Expected: FAIL because `template.dto.ts` does not exist.

- [ ] **Step 3: Implement DTOs**

Define:

```ts
export class TemplateIdDto { templateId: string }
export class ListTemplatesDto extends PaginationOptions { spaceId?: string }
export class CreateTemplateDto {
  title: string;
  description?: string;
  icon?: string;
  content?: Record<string, unknown>;
  spaceId?: string;
}
export class UpdateTemplateDto extends PartialType(CreateTemplateDto) {
  templateId: string;
}
export class UseTemplateDto {
  templateId: string;
  spaceId: string;
  parentPageId?: string;
}
```

Apply `@IsUUID()`, `@IsString()`, `@IsObject()`, `@IsOptional()`, `@MinLength(1)`, `@MaxLength(255)` for title/icon, `@MaxLength(2000)` for description, and trimming transforms. Keep `spaceId` optional so omission represents a global template.

- [ ] **Step 4: Verify GREEN**

Run the focused DTO test and expect PASS.

### Task 2: Service behavior and permissions

**Files:**
- Create: `apps/server/src/ee/template/template.service.ts`
- Create: `apps/server/src/ee/template/template.service.spec.ts`

- [ ] **Step 1: Write failing service tests**

Instantiate `TemplateService` with typed Jest mocks for `TemplateRepo`, `SpaceRepo`, `SpaceMemberRepo`, `PageService`, `SpaceAbilityFactory`, and `WorkspaceAbilityFactory`. Cover one behavior per test:

```ts
listTemplates(user, workspace, dto)
getTemplate(templateId, user, workspace)
createTemplate(dto, user, workspace)
updateTemplate(dto, user, workspace)
deleteTemplate(templateId, user, workspace)
useTemplate(dto, user, workspace)
```

Assert global and space access, member-template setting, cross-workspace hiding, destination page creation, parent validation delegated to `PageService`, and exact `400`/`403`/`404` exceptions.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter server test -- --runInBand ee/template/template.service.spec.ts`

Expected: FAIL because `TemplateService` does not exist.

- [ ] **Step 3: Implement minimal service**

Use these rules:

```ts
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

// list
const accessibleSpaceIds = await spaceMemberRepo.getUserSpaceIds(user.id);
return templateRepo.findTemplates(workspace.id, accessibleSpaceIds, dto, {
  spaceId: dto.spaceId,
});

// use
return pageService.create(user.id, workspace.id, {
  title: template.title,
  icon: template.icon ?? undefined,
  spaceId: dto.spaceId,
  parentPageId: dto.parentPageId,
  content: template.content ?? EMPTY_DOC,
  format: 'json',
});
```

Centralize helpers for loading a template in the authenticated workspace, validating source read access, validating global administration, validating space page permissions, and reading `workspace.settings.templates.allowMemberTemplates`. Validate ProseMirror JSON through the same conversion utilities used by pages before persistence. Persist `content`, `textContent`, `ydoc`, creator IDs, workspace ID, and scope through `TemplateRepo`.

- [ ] **Step 4: Verify GREEN and refactor**

Run the focused service test. Once green, remove duplicated permission branches into private helpers while keeping the suite green.

### Task 3: Controller routes

**Files:**
- Create: `apps/server/src/ee/template/template.controller.ts`
- Create: `apps/server/src/ee/template/template.controller.spec.ts`

- [ ] **Step 1: Write failing route metadata tests**

Use `Reflect.getMetadata(PATH_METADATA, target)` and `Reflect.getMetadata(METHOD_METADATA, target)` with the controller class and each handler from `@nestjs/common/constants` to assert controller prefix `templates`, `JwtAuthGuard`, and handlers for the empty path, `info`, `create`, `update`, `delete`, and `use`.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter server test -- --runInBand ee/template/template.controller.spec.ts`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement controller**

Create an authenticated controller using the existing decorators:

```ts
@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplateController {
  @Post() list(@Body() dto: ListTemplatesDto, @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace) {}
  @Post('info') info(@Body() dto: TemplateIdDto, @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace) {}
  @Post('create') create(@Body() dto: CreateTemplateDto, @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace) {}
  @Post('update') update(@Body() dto: UpdateTemplateDto, @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace) {}
  @Post('delete') delete(@Body() dto: TemplateIdDto, @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace) {}
  @Post('use') use(@Body() dto: UseTemplateDto, @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace) {}
}
```

Set `@HttpCode(HttpStatus.OK)` on every route and delegate without duplicating business rules.

- [ ] **Step 4: Verify GREEN**

Run the controller test and expect PASS.

### Task 4: Module registration

**Files:**
- Create: `apps/server/src/ee/template/template.module.ts`
- Create: `apps/server/src/ee/template/template.module.spec.ts`
- Modify: `apps/server/src/ee/ee.module.ts`

- [ ] **Step 1: Write failing module test**

Assert `TemplateModule` declares `TemplateController`, provides `TemplateService`, imports `PageModule`, and that `EeModule` imports `TemplateModule`.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter server test -- --runInBand ee/template/template.module.spec.ts`

Expected: FAIL because the module is absent and no routes are registered.

- [ ] **Step 3: Implement and register module**

```ts
@Module({
  imports: [PageModule],
  controllers: [TemplateController],
  providers: [TemplateService],
})
export class TemplateModule {}
```

Import `TemplateModule` in `EeModule` alongside `BaseModule` and `SearchAttachmentsModule`.

- [ ] **Step 4: Verify GREEN**

Run the module test and expect PASS.

### Task 5: Full verification

**Files:**
- Modify only files required by failures attributable to this implementation.

- [ ] **Step 1: Run all template tests**

Run: `pnpm --filter server test -- --runInBand ee/template`

Expected: all template suites PASS with no warnings.

- [ ] **Step 2: Run server build**

Run: `pnpm --filter server build`

Expected: Nest build exits 0 with no TypeScript errors.

- [ ] **Step 3: Run relevant regression tests**

Run: `pnpm --filter server test -- --runInBand core/page core/space core/workspace`

Expected: relevant suites PASS. Record any pre-existing unrelated test harness failures separately.

- [ ] **Step 4: Inspect final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only the approved template backend, tests, plan, and module registration are changed.
