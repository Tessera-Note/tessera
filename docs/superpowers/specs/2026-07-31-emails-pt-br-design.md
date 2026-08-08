# E-mails transacionais em português com identidade Tessera — design

## Contexto

O envio de e-mail passou a funcionar em 31/07/2026 (commit `865003fd`), depois de ter estado desligado em silêncio desde sempre: `MAIL_DRIVER` nunca chegava à VPS, o servidor caía no `LogDriver`, e esse driver retorna sem enviar e sem logar quando `NODE_ENV=production`.

Com o envio ligado, o conteúdo ficou exposto: os 15 templates estão em inglês, com a identidade genérica do Tessera. Para uma wiki interna de uma empresa brasileira, o primeiro contato de quem é convidado chega em outro idioma e sem cara de Tessera.

Este documento define a tradução e a identidade visual. Não trata de infraestrutura de envio, que já está resolvida.

## Decisões

### Idioma: texto fixo em pt-BR, sem i18n

Existe `users.locale` na base (default `en-US`) e o módulo de IA já o consulta via `languageFromLocale`. Ainda assim, a decisão é texto fixo.

**Por quê:** a Tessera é brasileira e a wiki é interna. Construir uma camada de tradução que hoje serviria a um único idioma é infraestrutura especulativa. Os templates são pequenos; se um dia houver demanda real por inglês, introduzir i18n depois não joga fora este trabalho — os textos já estarão isolados nos templates.

### Identidade: extraída do site institucional

Valores obtidos de `https://tessera.com.br` por inspeção de CSS computado, não inventados nem aproximados:

| Token | Valor | Origem no site |
| --- | --- | --- |
| Amarelo (CTA) | `#FFD31C` | fundo do botão "Quero contratar" |
| Preto (texto) | `#141414` | fundo escuro das seções |
| Cinza (moldura) | `#F4F4F4` | fundo do cabeçalho |
| Raio do botão | `100px` (pílula) | `border-radius` do mesmo CTA |
| Fonte | Montserrat | `font-family` de títulos e corpo |

O texto do CTA é preto sobre o amarelo. Não é escolha estética: `#FFD31C` com branco tem contraste ~1,5:1, ilegível; com preto fica ~14:1.

### Logo: hospedado na própria wiki

`main-logo-1.png` (104×36, PNG com transparência, 1,8 KB) copiado para `apps/client/public/tessera-wiki-logo.png`.

**Por quê não apontar para o site:** a URL de origem é `/wp-content/uploads/2025/11/main-logo-1.png`. Pasta datada de WordPress — qualquer reorganização da mídia do site derruba o logo dos e-mails sem aviso.

**Por que funciona:** `StaticModule` registra `fastifyStatic` sobre `client/dist` sem guard de autenticação (`apps/server/src/integrations/static/static.module.ts:69`). Arquivos em `apps/client/public/` são copiados para lá pelo Vite, ficando públicos em `https://<APP_URL>/<arquivo>` — que é o que cliente de e-mail exige.

O cabeçalho é claro porque a tinta do logo é escura. Um cabeçalho preto exigiria uma versão branca do logo, que não existe.

## Identidade visual aplicada

Todos os valores entram em `apps/server/src/integrations/transactional/css/styles.ts`. Nenhum template repete cor literal.

Além das cores, um defeito a corrigir: `paragraph` hoje tem `lineHeight: 1` (`styles.ts:26`), que gruda as linhas. Passa para `1.6`.

Stack de fonte: `Montserrat, 'Helvetica Neue', Helvetica, Arial, sans-serif`.

O cabeçalho (`MailHeader`, hoje vazio — o `<Heading>` está comentado em `partials/partials.tsx:34`) recebe o logo com `alt="Tessera"`, mais o nome em texto. A redundância é intencional: a maioria dos clientes bloqueia imagem no primeiro e-mail de um remetente desconhecido, que é exatamente o caso do convite.

O rodapé (`MailFooter`) troca "© Tessera, All Rights Reserved" por uma linha sóbria e sempre verdadeira: "Tessera · base de conhecimento da Tessera". Um rodapé único não consegue explicar por que cada pessoa recebeu cada e-mail, então a explicação específica fica no corpo do convite — "Você recebeu este e-mail porque alguém da equipe convidou você" — que é o caso em que importa: destinatário frio, remetente ainda sem reputação, risco real de marcação como spam.

## Tom de voz

Tratamento por "você". Frases curtas. Sem "por favor" e sem "clique aqui" — o texto do botão nomeia a ação.

Cada e-mail responde três coisas, nessa ordem: o que aconteceu, o que fazer, e o prazo quando existir. O convite atual diz apenas "You have been invited"; a versão em português diz também o que a wiki é. Como `workspace_invitations` não tem coluna de expiração, o convite não promete prazo.

Sentence case nos assuntos e botões, nunca Title Case.

## Escopo

### Templates (15)

Todos em `apps/server/src/integrations/transactional/emails/`:

`invitation`, `invitation-accepted`, `forgot-password`, `change-password`, `comment-created`, `comment-mention`, `comment-resolved`, `page-mention`, `page-update`, `page-update-digest`, `permission-granted`, `approval-requested`, `approval-rejected`, `verification-expiring`, `verification-expired`.

### Assuntos (12 strings, 5 arquivos)

Os assuntos **não** estão nos templates — ficam nos services. Traduzir só os `.tsx` deixaria "Reset your password" chegando com corpo em português.

| Arquivo | Linhas |
| --- | --- |
| `core/auth/services/auth.service.ts` | 165, 213, 274 |
| `core/workspace/services/workspace-invitation.service.ts` | 331, 480 |
| `core/notification/services/verification.notification.ts` | 120, 194, 262, 307 |
| `core/notification/services/page.notification.ts` | 120, 163 |
| `core/notification/services/comment.notification.ts` | 180 |

Os números de linha são do estado em `865003fd` e servem de ponto de partida, não de fonte de verdade. Antes de concluir, rodar `grep -rn "subject" apps/server/src/core --include=*.ts | grep -v spec` e conferir que nenhuma string em inglês sobrou — inclusive rótulos interpolados como `accessLabel` em `page.notification.ts:163`.

### Outros

- `partials/partials.tsx` — `MailHeader`, `MailFooter`, e a saudação. Hoje `getGreetingName` devolve `'there'` quando não há nome, o que em português produziria "Olá, there". A saudação deve ler "Olá, Cledson" quando houver nome e apenas "Olá" quando não houver.
- `css/styles.ts` — tokens.
- `apps/client/public/tessera-wiki-logo.png` — asset novo.

## Limitações conhecidas

**A Montserrat não vai aparecer para a maioria.** Cliente de e-mail praticamente não carrega webfont; Outlook e Gmail caem no fallback Helvetica/Arial. Declarar mesmo assim é barato e alguns clientes Apple respeitam, mas a identidade precisa se sustentar pela cor e pelo layout, não pela fonte.

**A pílula vira retângulo no Outlook.** O motor do Word ignora `border-radius`. Degradação aceitável; resolver exigiria VML, complexidade desproporcional.

**O logo fica suave em tela retina.** 104×36 é a resolução original disponível. Trocar por uma versão 2x no mesmo caminho resolve, sem mudar código.

**Os templates não são testáveis por jest.** O mapeamento em `apps/server/package.json` substitui todo `@tessera/transactional/emails/*` por um stub — foi o que impediu o `react-email` (ESM) de derrubar a suíte. Abrir exceção para um spec de render traria a árvore ESM inteira de volta; para conteúdo apresentacional, não compensa.

## Verificação

**Visual, com os templates reais:** `pnpm --filter server email:dev` sobe o preview do react-email na porta 5019 renderizando `./src/integrations/transactional/emails`. Cada um dos 15 deve ser conferido ali.

**Estático:** `pnpm --filter server build` e `npx tsc --noEmit -p apps/server/tsconfig.json` precisam continuar em zero. O CI já roda a suíte completa.

**Fim a fim:** o "esqueci minha senha" na tela de login dispara e-mail real sem precisar criar convite. É o caminho mais curto para ver o resultado numa caixa de entrada de verdade, inclusive para conferir como o assunto aparece na listagem.

## Fora de escopo

Infraestrutura de envio (resolvida em `865003fd`). Notificações in-app. Preferências de assinatura. Versão em inglês. Qualquer mudança nos serviços que disparam e-mail além da string do assunto.
