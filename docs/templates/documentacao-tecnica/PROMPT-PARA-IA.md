# Prompt para documentar projetos externos

Copie o prompt abaixo para a IA que estiver trabalhando no repositório do
projeto que será documentado. As URLs apontam para a versão oficial do modelo
na branch `main` do repositório `Cledson96/tessera`.

---

Quero que você analise este repositório e produza sua documentação técnica
completa usando obrigatoriamente o modelo oficial abaixo.

## Instruções e estrutura obrigatórias

Leia integralmente estes arquivos antes de analisar o projeto:

1. Guia e critérios do modelo:
   https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/README.md
2. Manifesto com a hierarquia de páginas:
   https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/manifest.json
3. Guia detalhado de preenchimento e documentação de rotas:
   https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/00-como-usar.html

Depois, leia todos os templates de páginas:

4. Página inicial:
   https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/00-home.html
5. Visão geral e contexto:
   https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/01-visao-geral.html
6. Arquitetura:
   https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/02-arquitetura.html
7. Contexto e containers:
   https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/02-01-contexto-containers.html
8. Componentes e fluxos:
   https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/02-02-componentes-fluxos.html
9. Integrações e dependências:
   https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/02-03-integracoes.html
10. Desenvolvimento:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/03-desenvolvimento.html
11. APIs e contratos:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/04-apis.html
12. Dados:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/05-dados.html
13. Operação e implantação:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/06-operacao.html
14. Segurança e conformidade:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/07-seguranca.html
15. Decisões de arquitetura:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/08-adrs.html
16. Histórico de mudanças:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/pages/09-historico.html

Leia também as fontes dos diagramas Draw.io:

17. Contexto do sistema:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/diagrams/01-contexto.drawio
18. Containers:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/diagrams/02-containers.drawio
19. Fluxo principal:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/diagrams/03-fluxo-principal.drawio
20. Implantação:
    https://raw.githubusercontent.com/Cledson96/tessera/main/docs/templates/documentacao-tecnica/diagrams/04-implantacao.drawio

## Dados do projeto

- Nome: [NOME DO PROJETO]
- Repositório: [URL DO REPOSITÓRIO]
- Branch: [BRANCH]
- Commit analisado: [COMMIT]
- Responsável técnico: [PESSOA OU TIME]
- Canal de contato: [CANAL]
- URL do sistema: [URL]
- Tessera: https://wiki.cledson.com.br
- Espaço Tessera de destino: [NOME OU ID]

## Objetivo

Analise código, configurações, testes, contratos, banco de dados,
infraestrutura, pipelines e documentação existente. Preencha o conteúdo de
todas as páginas aplicáveis sem mudar a hierarquia definida no manifesto.

Não invente informações. Quando não houver evidência suficiente, preserve o
placeholder e registre uma pergunta pendente. Diferencie fatos confirmados,
inferências, recomendações e informações não encontradas.

Para afirmações técnicas importantes, cite o caminho do arquivo e as linhas que
sustentam a conclusão. Registre também a branch, o commit analisado, a data e o
nível de confiança.

## Rotas e contratos

Para cada rota encontrada, documente:

- método e caminho;
- finalidade e fluxo de negócio;
- autenticação, autorização, papéis e escopos;
- parâmetros de path, query, header e body;
- tipo, formato, obrigatoriedade, valor padrão e validações;
- exemplo executável com cURL;
- exemplo de resposta JSON sanitizado;
- status de sucesso e todos os erros relevantes;
- paginação, filtros e ordenação;
- rate limit, timeout, retry e idempotência;
- transações e efeitos colaterais;
- eventos, filas e integrações acionadas;
- arquivo que implementa a rota;
- testes que comprovam o comportamento.

## Conteúdo e segurança

Use HTML compatível com Tessera para preservar tabelas, callouts, toggles,
colunas, status, tarefas, código com syntax highlighting, Mermaid e blocos
Draw.io. Exemplos devem ser sintéticos e copiáveis.

Nunca publique tokens, chaves, senhas, dados pessoais, payloads reais ou
detalhes de vulnerabilidades exploráveis.

## Processo obrigatório

### Fase 1 — Descoberta

Examine o repositório e apresente tecnologias, módulos, rotas, bancos,
integrações, ambientes, fluxos críticos, lacunas e perguntas. Não altere nem
publique páginas.

### Fase 2 — Plano

Relacione as evidências encontradas a cada página do manifesto. Informe quais
páginas serão preenchidas, quais não se aplicam e quais dependem de informação
humana. Pare e aguarde aprovação.

### Fase 3 — Produção

Após aprovação, produza os HTMLs completos, os diagramas e um relatório de
fontes e lacunas. Ainda não publique no Tessera.

### Fase 4 — Publicação

Publique somente após nova aprovação. Leia a árvore existente antes de alterar,
não crie duplicatas, atualize somente páginas aprovadas e valide o conteúdo
relendo cada página pela API.

Antes de começar, informe o escopo entendido, as fontes que analisará, os riscos
e as informações adicionais necessárias.

---

## Atualização posterior por diff

Para atualizar uma documentação já existente, use:

```text
Atualize a documentação usando o mesmo modelo oficial.

Commit anteriormente documentado: [COMMIT ANTERIOR]
Commit atual: [COMMIT ATUAL]

Analise o diff entre os commits e determine quais páginas foram afetadas. Não
reescreva páginas não afetadas. Mostre o plano antes de alterar ou publicar.

Registre no Histórico de mudanças os commits, páginas alteradas, fontes, motivo,
nível de confiança e pendências para revisão humana.
```

