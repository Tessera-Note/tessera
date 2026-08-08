# Modelo de documentação técnica para Tessera

Este diretório contém o modelo oficial para documentar sistemas no Tessera. O
modelo foi desenhado para ser criado como uma árvore de páginas, em vez de uma
única página extensa, e para ser preenchido tanto por pessoas quanto por uma
automação de IA.

Para documentar um projeto localizado em outro repositório, copie o prompt de
[PROMPT-PARA-IA.md](./PROMPT-PARA-IA.md). Ele referencia cada parte do modelo
por uma URL pública do GitHub, sem depender de caminhos locais.

## Estrutura do espaço

```text
📘 {{PROJECT_NAME}} — Documentação técnica
├── 🧰 00. Como usar este modelo
├── 🎯 01. Visão geral e contexto
├── 🏗️ 02. Arquitetura
│   ├── 🌐 02.1 Contexto e containers
│   ├── 🧩 02.2 Componentes e fluxos
│   └── 🔌 02.3 Integrações e dependências
├── 💻 03. Desenvolvimento
├── 🔗 04. APIs e contratos
├── 🗄️ 05. Dados
├── 🚀 06. Operação e implantação
├── 🔐 07. Segurança e conformidade
├── 🧭 08. Decisões de arquitetura (ADRs)
└── 📝 09. Histórico de mudanças
```

O arquivo [manifest.json](./manifest.json) é a fonte de verdade da hierarquia.
Cada item aponta para um HTML compatível com o endpoint `POST /api/pages/create`
usando `format: "html"`. As páginas usam recursos nativos do editor:

- títulos H1–H3, que alimentam o sumário lateral automático;
- callouts de informação, sucesso, atenção e perigo;
- colunas para metadados e resumos;
- blocos recolhíveis (`details`) para conteúdo complementar;
- status visual e lista automática de subpáginas;
- blocos de código, tabelas, tarefas e diagramas Mermaid;
- espaços reservados de Draw.io, editáveis pelo editor do Tessera.

## Campos padronizados

Todos os campos substituíveis usam `{{UPPER_SNAKE_CASE}}`. A automação futura
deve preservar campos sem informação confirmada e nunca inventar valores.

| Campo | Descrição | Exemplo |
|---|---|---|
| `{{PROJECT_NAME}}` | Nome oficial do sistema | Tessera |
| `{{PROJECT_DESCRIPTION}}` | Resumo curto do propósito | Wiki colaborativa |
| `{{REPOSITORY_URL}}` | URL HTTPS do repositório | `https://github.com/org/repo` |
| `{{DEFAULT_BRANCH}}` | Branch principal | `main` |
| `{{DOCUMENT_OWNER}}` | Time ou pessoa responsável | Plataforma |
| `{{TECH_LEAD}}` | Responsável técnico | Nome da pessoa |
| `{{DOC_STATUS}}` | Rascunho, Em revisão, Aprovado ou Obsoleto | Em revisão |
| `{{DOC_VERSION}}` | Versão do conjunto documental | `1.0.0` |
| `{{LAST_UPDATED_AT}}` | Data ISO da última revisão | `2026-07-14` |
| `{{NEXT_REVIEW_AT}}` | Data ISO da próxima revisão | `2026-10-14` |
| `{{SYSTEM_URL}}` | URL principal do sistema | `https://app.exemplo.com` |
| `{{CONTACT_CHANNEL}}` | Canal de suporte técnico | `#time-plataforma` |

## Diagramas

Os arquivos em `diagrams/` são fontes Draw.io válidas e podem ser abertos no
diagrams.net. No Tessera, cada página de arquitetura já contém um bloco Draw.io
vazio. Abra o bloco, importe o XML correspondente e salve o diagrama. Manter o
fonte no repositório permite revisão de mudanças e atualização pela automação.

Convenção mínima para todos os diagramas:

- título, escopo e legenda explícitos;
- setas nomeadas com protocolo ou tipo de dado;
- fronteiras de confiança e sistemas externos identificados;
- nenhum segredo, token, IP pessoal ou credencial;
- data e versão registradas no texto da página, não desenhadas no diagrama.

## Critério de qualidade

Uma página somente deve mudar de `Rascunho` para `Aprovado` quando não tiver
marcadores críticos pendentes, possuir fontes rastreáveis e tiver sido revisada
pelo responsável indicado. Conteúdo não aplicável deve ser marcado como “Não se
aplica”, acompanhado de justificativa; não deve ser simplesmente apagado.

## Compatibilidade confirmada

O modelo foi conferido com a documentação oficial do Tessera em 14/07/2026:

- [Editor](https://docmost.com/docs/user-guide/editor): código com realce de
  sintaxe, tabelas, callouts, toggles, status, subpáginas, anexos, embeds,
  fórmulas, comentários e formatação rica;
- [Páginas](https://docmost.com/docs/user-guide/pages): hierarquia, sumário
  automático, âncoras, histórico, exportação e compartilhamento de subpáginas;
- [Diagramas](https://docmost.com/docs/user-guide/diagrams): Mermaid, Draw.io e
  Excalidraw, com os diagramas visuais armazenados como SVG editável;
- [REST API](https://docmost.com/docs/user-guide/api): chaves pessoais herdam as
  permissões do usuário;
- [MCP](https://docmost.com/docs/user-guide/mcp): clientes de IA podem pesquisar,
  ler, criar e atualizar páginas e espaços.

O fork deste repositório também habilita os controladores HTTP existentes para
chaves pessoais; consulte [../../open-api.md](../../open-api.md). Para automação,
HTML é o formato principal deste modelo, pois preserva blocos ricos que seriam
reduzidos em uma conversão para Markdown.
