# Backend completo de modelos

## Contexto

O frontend de modelos já está presente e usa os endpoints internos `POST /api/templates`, `POST /api/templates/info`, `POST /api/templates/create`, `POST /api/templates/update`, `POST /api/templates/delete` e `POST /api/templates/use`. A rota de criação está correta para a versão 0.95.0 do projeto.

O fork removeu o gitlink privado `apps/server/src/ee` e o substituiu por uma implementação local que contém apenas os módulos Bases e Search Attachments. O controller e o serviço de modelos não foram repostos. Por isso o NestJS responde `Cannot POST /api/templates/create`; o mesmo módulo ausente também impede carregar o conteúdo de um modelo selecionado.

## Objetivo

Restaurar no backend local todos os fluxos de modelos já esperados pelo frontend, mantendo isolamento por workspace, escopo global ou de espaço e as permissões existentes do Tessera.

## Arquitetura

Será criado um módulo focado em `apps/server/src/ee/template`, composto por:

- `TemplateController`: expõe as seis rotas usadas pelo frontend, exige autenticação e traduz o contexto autenticado em chamadas do serviço.
- `TemplateService`: concentra regras de acesso, persistência de modelos e conversão de um modelo em página.
- DTOs: validam IDs, paginação e campos mutáveis antes de chegarem ao serviço.
- `TemplateModule`: registra controller e serviço e será importado pelo `EeModule` local.

A implementação reutilizará `TemplateRepo`, `PageRepo`, `SpaceRepo`, `SpaceMemberRepo`, `SpaceAbilityFactory` e `WorkspaceAbilityFactory`. Não haverá alteração das URLs no frontend nem movimentação da funcionalidade para o `CoreModule`.

## Contrato HTTP

Todas as rotas usam `POST`, ficam sob `/api/templates` por causa do prefixo global já configurado e exigem uma sessão válida.

| Rota | Entrada principal | Resultado |
| --- | --- | --- |
| `/templates` | paginação e `spaceId` opcional | modelos globais e modelos dos espaços acessíveis |
| `/templates/info` | `templateId` | modelo com `content` |
| `/templates/create` | `title`, `description`, `icon`, `content`, `spaceId` opcionais conforme o campo | modelo criado |
| `/templates/update` | `templateId` e campos mutáveis | modelo atualizado |
| `/templates/delete` | `templateId` | resposta vazia de sucesso |
| `/templates/use` | `templateId`, `spaceId`, `parentPageId` opcional | página criada a partir do modelo |

O formato seguirá o interceptor HTTP atual do projeto. Internamente, o controller retorna diretamente os objetos do domínio, como os demais controllers NestJS.

## Permissões

- Toda consulta é limitada ao `workspaceId` autenticado.
- Modelos globais podem ser vistos por membros do workspace.
- Modelos ligados a espaço só podem ser vistos por usuários com leitura naquele espaço.
- Criar um modelo global exige permissão administrativa no workspace.
- Criar, atualizar ou excluir um modelo de espaço exige edição de páginas no espaço.
- Atualizar ou excluir um modelo global exige permissão administrativa no workspace.
- Mover um modelo entre escopos valida tanto a administração do escopo atual quanto a permissão do novo escopo.
- Usar um modelo exige leitura no escopo de origem e permissão de criação de página no espaço de destino.
- Se `parentPageId` for informado, a página pai deve existir no mesmo workspace e no espaço de destino.
- A configuração `workspace.settings.templates.allowMemberTemplates` permite que membros criem modelos somente em espaços nos quais tenham acesso de edição; ela não concede criação de modelos globais.

## Persistência e fluxo de dados

Ao criar ou atualizar um modelo, o serviço persiste o JSON ProseMirror em `templates.content`, gera `textContent` para pesquisa e gera `ydoc` a partir do mesmo conteúdo. Um documento vazio válido será usado quando `content` não for enviado na criação.

Ao usar um modelo, o serviço:

1. busca o modelo com conteúdo no workspace autenticado;
2. valida acesso ao modelo e ao espaço de destino;
3. valida a página pai, quando informada;
4. cria uma página com novo `slugId`, posição no final do nível escolhido, título, ícone, JSON ProseMirror, texto e Ydoc derivados do modelo;
5. atribui o usuário atual como criador e último editor;
6. retorna a página criada no formato esperado pelo frontend.

O editor de modelos já bloqueia inserções de mídia dependentes de página. Portanto, esta implementação não introduzirá cópia de anexos, que não faz parte do contrato atual.

## Validação e erros

- DTOs rejeitam IDs inválidos, títulos vazios, limites fora da faixa e payloads inesperados conforme a configuração global de validação.
- Recursos inexistentes ou fora do workspace retornam `404`, sem revelar sua existência em outro workspace.
- Acesso insuficiente retorna `403`.
- Conteúdo ProseMirror inválido retorna `400`.
- Operações de atualização sem campos mutáveis retornam `400`.

## Testes e verificação

A implementação seguirá TDD. Primeiro serão criados testes unitários do serviço que reproduzem a ausência do fluxo e cobrem:

- listagem filtrada por espaços acessíveis;
- leitura de modelo global e de espaço;
- criação global e em espaço com permissões permitidas e negadas;
- atualização, mudança de escopo e exclusão;
- criação de página a partir de modelo, incluindo pai opcional;
- isolamento entre workspaces e erros `400`, `403` e `404`.

Também haverá teste do controller/módulo para garantir que as seis rotas sejam registradas. A verificação final executará os testes focados, a suíte relevante do servidor e o build do backend.

## Fora de escopo

- Alterar a interface de modelos.
- Publicar Templates na API pública documentada ou adicionar autenticação por API key.
- Restaurar outros módulos privados do submódulo EE.
- Copiar anexos para dentro ou para fora de modelos.
- Alterar o sistema de licenciamento ou as flags de funcionalidades.
