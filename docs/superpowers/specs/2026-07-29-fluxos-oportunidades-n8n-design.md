# Design da documentação dos fluxos de oportunidades no n8n

## Objetivo

Criar no Tessera uma página voltada a negócio e operação que explique, de ponta a ponta, como as oportunidades são selecionadas, enviadas pelo WhatsApp, respondidas e consolidadas no relatório diário.

## Público

Lideranças, operação e pessoas de negócio que precisam compreender e acompanhar o processo sem conhecer a configuração interna do n8n.

## Fonte da documentação

A página será baseada na configuração atual lida diretamente pelo MCP do n8n em 29 de julho de 2026:

- `Envio proposta V2 — ClickHouse` (`oWzEhSCSJq06RYPy`);
- `Receber respostas V2` (`fvUCg7BvMP3EW7n8`);
- `Relatório diário de oportunidades v2` (`CPy3yQGhIgmu3x75`).

## Estrutura editorial

1. Objetivo da automação.
2. Visão geral dos três fluxos.
3. Diagrama ponta a ponta.
4. Explicação operacional do envio.
5. Explicação operacional das respostas.
6. Explicação operacional do relatório diário.
7. Regras de priorização e seleção.
8. Caminhos possíveis para o usuário no WhatsApp.
9. Informações registradas e indicadores.
10. Falhas, alertas e comportamento esperado da operação.
11. Situação atual dos workflows.
12. Pontos de atenção.

## Diagrama

O diagrama principal mostrará:

`Oportunidades no banco` → `Agrupamento por grupo e concessionária` → `Validação de contato` → `Priorização e seleção de até 3 oportunidades` → `Template no WhatsApp` → `Decisão do usuário` → `Envio e registro das oportunidades` → `Resultado informado` → `Relatório diário por e-mail e Excel`.

Os desvios mostrarão:

- grupo sem contato;
- erro no envio pelo WhatsApp;
- escolha “Não verificar”;
- falha técnica ou de banco;
- falha no envio do relatório.

## Linguagem e nível de detalhe

A página usará linguagem simples e nomes de negócio. Nomes técnicos de nós, SQL, credenciais e payloads não serão exibidos. Tabelas e componentes internos serão citados somente quando ajudarem a explicar rastreabilidade, auditoria ou geração do relatório.

## Conteúdo essencial por fluxo

### Envio proposta V2 — ClickHouse

- Consulta as oportunidades da data de referência.
- Organiza as oportunidades por grupo econômico, concessionária e cliente.
- Verifica a existência de contato com telefone.
- Aplica regras específicas para Eldorado, Barigui e demais grupos.
- Seleciona até três oportunidades.
- Registra o envio antes de chamar o WhatsApp.
- Envia o template inicial e registra o identificador da mensagem.
- Gera alertas por e-mail em caso de contato ausente ou falha de envio.

### Receber respostas V2

- Recebe eventos da Meta pelo webhook `/webhook/whatsapp`.
- Separa mensagens recebidas de atualizações de status.
- Identifica as escolhas “Ver oportunidades” e “Não verificar”.
- Envia cada oportunidade individualmente quando solicitado.
- Interpreta e registra o resultado de cada oportunidade.
- Confirma ao usuário a resposta registrada.
- Registra falhas técnicas e envia alertas operacionais.

### Relatório diário de oportunidades v2

- Pode iniciar por agenda ou manualmente.
- Impede duplicidade por data de referência.
- Consolida indicadores e detalhes do processo.
- Gera um arquivo Excel com resumo e detalhamento.
- Envia o relatório por e-mail.
- Registra sucesso ou falha e alerta em caso de erro.

## Situação atual a destacar

- `Receber respostas V2`: ativo.
- `Envio proposta V2 — ClickHouse`: inativo e com gatilho manual.
- `Relatório diário de oportunidades v2`: inativo, embora tenha gatilho agendado e manual.

Essa informação será apresentada como fotografia do ambiente em 29 de julho de 2026, evitando que a documentação pareça definir um estado permanente.

## Critérios de qualidade

- Uma pessoa de operação deve entender o processo sem abrir o n8n.
- O diagrama deve mostrar o caminho principal e as exceções mais relevantes.
- Regras e estados devem corresponder à configuração lida pelo MCP.
- Nenhum segredo, token, credencial ou dado pessoal deve aparecer.
- A página deve indicar claramente os workflows inativos para evitar uma interpretação incorreta sobre automação em produção.

## Publicação

A documentação final será criada como uma única página no Tessera. Antes da publicação, será verificado o espaço e a página-pai adequados na wiki. A página publicada será revisada visualmente para confirmar título, seções, diagrama e legibilidade.
