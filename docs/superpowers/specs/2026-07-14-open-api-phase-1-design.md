# Tessera Open API — Fase 1

## Objetivo

Disponibilizar uma API pública no fork open source do Tessera que seja compatível com o contrato documentado pela API oficial para autenticação por chave, páginas e espaços. A implementação será independente e não reutilizará código da edição Enterprise.

## Escopo

- Gerenciamento de chaves de API pessoais:
  - `POST /api/api-keys`
  - `POST /api/api-keys/create`
  - `POST /api/api-keys/update`
  - `POST /api/api-keys/revoke`
- Autenticação com `Authorization: Bearer dm_...`.
- Compatibilidade por API key com as rotas existentes de páginas e espaços:
  - páginas: consulta, criação, atualização e exclusão;
  - espaços: listagem, consulta, criação, atualização e exclusão.
- Respostas no envelope `{ success, status, data }`, já aplicado globalmente pelo servidor.
- Testes de integração para autenticação, revogação, autorização e CRUD essencial.

## Fora do escopo

- SSO, SCIM, IA, MFA e demais capacidades Enterprise.
- Copiar ou importar código coberto pela licença Enterprise.
- Alterar o comportamento de autorização de usuários autenticados por sessão.

## Arquitetura

Uma nova área `core/api-key` no servidor será responsável por criar, listar, renomear, revogar e validar chaves. Ela usará a tabela `apiKeys` e o `TokenService` já presentes no schema e no núcleo do projeto, mas terá serviços, DTOs e controllers próprios no código open source.

O `JwtStrategy` continuará sendo a única porta de autenticação. Quando receber um token Bearer do tipo `api_key`, a estratégia delegará a validação ao novo serviço open source. Uma chave válida resolve o usuário e o workspace da chave; os controllers existentes recebem o mesmo contexto que recebem em sessões normais.

## Segurança

- Chaves são JWTs assinados pelo segredo da aplicação e incluem somente o identificador da chave, do usuário e do workspace.
- A chave bruta é retornada somente na criação; o banco armazena metadados e permite validar expiração e revogação em cada chamada.
- Chaves revogadas, expiradas ou vinculadas a usuário/workspace inválido serão rejeitadas com `401`.
- Uma chave herda as permissões atuais de seu proprietário. Nenhuma rota ignora CASL, restrições de página ou permissões de espaço.
- Ações destrutivas continuam usando os mesmos DTOs e validações dos controllers existentes.

## Compatibilidade

As rotas usam o prefixo `/api`, método HTTP e JSON definidos na documentação oficial. A API key é enviada em `Authorization: Bearer <token>`. O comportamento de paginação e o formato de erro permanecem os do servidor Tessera.

## Fluxo

1. Um usuário autenticado por sessão cria uma chave em `/api/api-keys/create`.
2. A integração guarda a chave retornada e a envia em cada chamada como Bearer token.
3. `JwtStrategy` valida a chave e injeta usuário/workspace na requisição.
4. As rotas existentes de páginas e espaços executam suas regras de autorização normalmente.

## Verificação

- Criar chave, autenticar e chamar leitura de espaço/página.
- Confirmar que permissões de leitor e editor são respeitadas.
- Criar, editar e excluir página e espaço com chave autorizada.
- Revogar a chave e confirmar que novas chamadas retornam `401`.
- Executar a suíte de testes afetada e o build do servidor.
