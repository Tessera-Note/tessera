# E-mails em português com identidade Tessera — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Traduzir os 15 templates de e-mail transacional e os 12 assuntos para pt-BR, aplicando a identidade visual da Tessera extraída do site institucional.

**Architecture:** Toda a identidade entra em dois arquivos compartilhados — `css/styles.ts` (tokens) e `partials/partials.tsx` (cabeçalho, rodapé, saudação). Os 15 templates só consomem: nenhum repete cor, fonte ou saudação. Os assuntos ficam nos services que disparam o envio e são traduzidos em contexto. Sem camada de i18n: texto fixo em português, decisão registrada no spec.

**Tech Stack:** React Email (componentes `.tsx` renderizados server-side), NestJS, TypeScript.

Spec: [docs/superpowers/specs/2026-07-31-emails-pt-br-design.md](../specs/2026-07-31-emails-pt-br-design.md)

## Global Constraints

- **Nunca rode `jest` nesta máquina.** Trava o PC do usuário. Os templates nem são cobertos por jest (o mapeamento em `apps/server/package.json` substitui `@tessera/transactional/emails/*` por um stub). Gates: `pnpm --filter server build` e `npx tsc --noEmit -p apps/server/tsconfig.json`, ambos precisam sair com 0.
- **Não faça `git push`.** Commite localmente; o push é decisão do usuário.
- Paleta Tessera, valores exatos: amarelo `#FFD31C`, preto `#141414`, cinza de moldura `#F4F4F4`, cinza de texto secundário `#5F5E5A`, borda `#E6E6E6`. Botão em pílula: `borderRadius: '100px'`. Texto do botão é preto sobre o amarelo — branco sobre `#FFD31C` tem contraste ~1,5:1 e é ilegível.
- Stack de fonte, exata: `Montserrat, 'Helvetica Neue', Helvetica, Arial, sans-serif`.
- Terminologia igual à da interface, conforme `apps/client/public/locales/pt-BR/translation.json`: Space → **espaço**, Page → **página**, Comment → **comentário**, Workspace → **workspace** (mantido em inglês pelos tradutores do produto).
- Tom: tratamento por "você", frases curtas, sentence case em assuntos e botões. Sem "por favor", sem "clique aqui" — o texto do botão nomeia a ação.
- **Não afirme prazos que não existem.** Convites **não expiram** (a tabela `workspace_invitations` não tem coluna de expiração). O reset de senha expira em **30 minutos** (`auth.service.ts:197`) — esse sim pode e deve ser dito.
- Comentários de código em inglês (padrão do repositório). Mensagens de commit em inglês, formato `feat(mail):` / `fix(mail):`.
- Não adicione dependências.
- Trabalhe na branch `feat/emails-pt-br`. Não commite direto em `main`.

## File Structure

**Criados:**
- `apps/client/public/tessera-wiki-logo.png` — logo servido publicamente para os e-mails.

**Modificados:**
- `apps/server/src/integrations/transactional/css/styles.ts` — tokens da Tessera; único lugar com valores de cor.
- `apps/server/src/integrations/transactional/partials/partials.tsx` — `MailHeader`, `MailFooter`, novo `Greeting`, remoção de `getGreetingName`.
- Os 15 arquivos em `apps/server/src/integrations/transactional/emails/`.
- `apps/server/src/core/auth/services/auth.service.ts` — 3 assuntos.
- `apps/server/src/core/workspace/services/workspace-invitation.service.ts` — 2 assuntos.
- `apps/server/src/core/notification/services/verification.notification.ts` — 4 assuntos.
- `apps/server/src/core/notification/services/page.notification.ts` — 2 assuntos + `accessLabel`.
- `apps/server/src/core/notification/services/comment.notification.ts` — 1 assunto.

---

### Task 1: Tokens da Tessera e logo

**Files:**
- Modify: `apps/server/src/integrations/transactional/css/styles.ts`
- Create: `apps/client/public/tessera-wiki-logo.png`

**Interfaces:**
- Produces: os tokens exportados de `styles.ts` que todas as tasks seguintes consomem — `fontFamily`, `main`, `container`, `content`, `paragraph`, `paragraphMuted`, `h1`, `logo`, `link`, `footer`, `button`, `brand`.
- Produces: o logo em `https://<APP_URL>/tessera-wiki-logo.png`.

- [ ] **Step 1: Colocar o logo nos assets públicos**

O arquivo já foi baixado e verificado (PNG 104×36, RGBA com transparência, 1,8 KB):

```bash
cp "C:/Users/GBXN0056/AppData/Local/Temp/claude/C--Users-GBXN0056-Documents-tessera/f60d0504-eff2-4298-8657-38fffb083fbf/scratchpad/logo.png" apps/client/public/tessera-wiki-logo.png
```

Se o arquivo do scratchpad não existir mais, baixe de novo:

```bash
curl -sSL -o apps/client/public/tessera-wiki-logo.png "https://tessera.com.br/wp-content/uploads/2025/11/main-logo-1.png"
```

Confira que veio um PNG válido de 104×36:

```bash
node -e "const b=require('fs').readFileSync('apps/client/public/tessera-wiki-logo.png'); console.log(b.slice(1,4).toString()==='PNG', b.readUInt32BE(16)+'x'+b.readUInt32BE(20))"
```

Esperado: `true 104x36`

- [ ] **Step 2: Reescrever os tokens**

Substitua o conteúdo inteiro de `apps/server/src/integrations/transactional/css/styles.ts`:

```ts
// Tessera brand values, read off https://tessera.com.br: the yellow is the
// "Quero contratar" CTA fill, the pill radius is that button's, and the grey
// is the site header. Black on yellow is not a style choice — white on
// #FFD31C lands around 1.5:1 contrast and is unreadable.
export const brand = {
  yellow: '#FFD31C',
  black: '#141414',
  greyBg: '#F4F4F4',
  greyText: '#5F5E5A',
  border: '#E6E6E6',
};

// Mail clients rarely load webfonts, so Montserrat is declared for the few
// that do (mostly Apple Mail) and the stack degrades everywhere else.
export const fontFamily =
  "Montserrat, 'Helvetica Neue', Helvetica, Arial, sans-serif";

export const main = {
  backgroundColor: brand.greyBg,
  fontFamily,
};

export const container = {
  maxWidth: '580px',
  margin: '10px auto',
  backgroundColor: '#ffffff',
  borderColor: brand.border,
  borderRadius: '12px',
  borderWidth: '1px',
  borderStyle: 'solid',
  padding: '4px 0',
};

export const content = {
  padding: '8px 24px 16px 24px',
};

export const paragraph = {
  fontFamily,
  color: brand.black,
  lineHeight: 1.6,
  fontSize: 14,
  margin: '0 0 10px 0',
};

export const paragraphMuted = {
  ...paragraph,
  color: brand.greyText,
};

export const h1 = {
  fontFamily,
  color: brand.black,
  fontSize: '20px',
  fontWeight: 500,
  padding: '0',
};

export const logo = {
  textAlign: 'center' as const,
  padding: '14px 0 6px 0',
};

export const link = {
  color: brand.black,
  textDecoration: 'underline',
};

export const footer = {
  maxWidth: '580px',
  margin: '0 auto',
};

export const button = {
  backgroundColor: brand.yellow,
  borderRadius: '100px',
  color: brand.black,
  fontFamily,
  fontSize: '14px',
  fontWeight: 500,
  textDecoration: 'none',
  textAlign: 'center' as const,
  padding: '11px 22px',
};
```

Nota sobre o que mudou além das cores: `lineHeight` era `1`, o que grudava as linhas; `paragraph` ganhou `margin` própria; `container` ganhou `borderStyle` (antes declarava cor e largura de borda sem estilo, então a borda não aparecia).

- [ ] **Step 3: Verificar**

```bash
pnpm --filter server build && npx tsc --noEmit -p apps/server/tsconfig.json
```

Esperado: ambos com saída de erro vazia. Se `packages/base-formula/dist` não existir, rode antes `pnpm --filter @tessera/base-formula build`.

O `button` perdeu as chaves `display` e `width`, que existiam antes. Confirme que nada fora de `partials.tsx` as consome:

```bash
grep -rn "button\." apps/server/src/integrations/transactional --include=*.tsx
```

Esperado: apenas usos dentro de `partials.tsx`.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/integrations/transactional/css/styles.ts apps/client/public/tessera-wiki-logo.png
git commit -m "feat(mail): Tessera brand tokens and logo asset"
```

---

### Task 2: Cabeçalho, rodapé e saudação

**Files:**
- Modify: `apps/server/src/integrations/transactional/partials/partials.tsx`

**Interfaces:**
- Consumes: `brand`, `fontFamily`, `paragraph`, `button`, `container`, `footer`, `logo`, `main` de `css/styles.ts` (Task 1).
- Produces: `MailBody`, `MailHeader`, `MailFooter`, `EmailButton` (assinatura inalterada: `{ href, children }`) e o novo `Greeting` com assinatura `({ name }: { name?: string })`.
- Produces: `getGreetingName` deixa de existir. Tasks 4 e 5 precisam disso — `page-update-email.tsx` e `page-update-digest-email.tsx` importam essa função hoje e passam a usar `<Greeting name={userName} />`.

- [ ] **Step 1: Substituir MailHeader**

Em `apps/server/src/integrations/transactional/partials/partials.tsx`, troque a função `MailHeader` inteira:

```tsx
export function MailHeader() {
  return (
    <Section style={logo}>
      {/* Logo and wordmark together on purpose: most clients block images on
          the first mail from an unknown sender, which is exactly the invite
          case, and the header would otherwise render empty. */}
      <Img
        src={`${process.env.APP_URL || ''}/tessera-wiki-logo.png`}
        alt="Tessera"
        width="104"
        height="36"
        style={{ display: 'block', margin: '0 auto 6px auto' }}
      />
      <Text
        style={{
          fontFamily,
          fontSize: '13px',
          fontWeight: 500,
          color: brand.black,
          margin: 0,
          textAlign: 'center' as const,
        }}
      >
        Tessera
      </Text>
    </Section>
  );
}
```

Acrescente `Img` ao import de `react-email` e `brand`, `fontFamily` ao import de `../css/styles`. O import atual de styles é `{ button as buttonStyle, container, footer, h1, logo, main }`; `h1` não é mais usado — remova-o e confirme com o build.

- [ ] **Step 2: Substituir MailFooter**

```tsx
export function MailFooter() {
  return (
    <Section style={footer}>
      <Row>
        <Text
          style={{
            fontFamily,
            textAlign: 'center' as const,
            color: brand.greyText,
            fontSize: '12px',
          }}
        >
          Tessera · base de conhecimento da Tessera
        </Text>
      </Row>
    </Section>
  );
}
```

O texto anterior era "© {ano} Tessera, All Rights Reserved". Um rodapé único não consegue explicar por que cada pessoa recebeu cada e-mail, então ele fica genérico e sempre verdadeiro; a explicação específica vai no corpo do convite (Task 3), que é o caso em que importa — destinatário frio, remetente sem reputação.

- [ ] **Step 3: Trocar getGreetingName por Greeting**

Remova a função `getGreetingName` e acrescente:

```tsx
export function Greeting({ name }: { name?: string }) {
  const first = name?.trim().split(' ')[0];
  return <Text style={paragraph}>{first ? `Olá, ${first}` : 'Olá'}</Text>;
}
```

Acrescente `paragraph` ao import de `../css/styles`.

Por que um componente e não uma string: o `getGreetingName` devolvia `'there'` quando não havia nome, o que em português produziria "Olá, there". Além disso, treze dos quinze templates repetiam `<Text style={paragraph}>Hi there,</Text>` na mão. O componente resolve as duas coisas de uma vez.

- [ ] **Step 4: Ajustar o botão à pílula**

Na função `EmailButton`, o `<td>` e o `<a>` leem chaves de `buttonStyle`. Troque o bloco inteiro do `<td>`/`<a>` por:

```tsx
        <td
          style={{
            backgroundColor: buttonStyle.backgroundColor,
            borderRadius: buttonStyle.borderRadius,
            textAlign: 'center' as const,
          }}
        >
          <a
            href={href}
            target="_blank"
            style={{
              color: buttonStyle.color,
              fontFamily: buttonStyle.fontFamily,
              fontSize: buttonStyle.fontSize,
              fontWeight: buttonStyle.fontWeight,
              textDecoration: 'none',
              display: 'inline-block',
              padding: buttonStyle.padding,
            }}
          >
            {children}
          </a>
        </td>
```

Troque também a margem da `<table>` de `'0 0 15px 15px'` para `'4px 0 8px 24px'`, para alinhar com o novo `padding` de `content`.

O `border-radius: 100px` vira retângulo no Outlook, que ignora a propriedade. É degradação aceitável e está registrada no spec como limitação conhecida — não tente resolver com VML.

- [ ] **Step 5: Verificar**

```bash
pnpm --filter server build && npx tsc --noEmit -p apps/server/tsconfig.json
```

O build vai falhar em `page-update-email.tsx` e `page-update-digest-email.tsx`, que ainda importam `getGreetingName`. Isso é esperado e será corrigido nas Tasks 4 e 5. Para manter esta task verificável isoladamente, aplique agora nesses dois arquivos apenas a troca mecânica de import e de uso:

- remova `getGreetingName` do import de `../partials/partials` e acrescente `Greeting`;
- troque `<Text style={paragraph}>Hi {getGreetingName(userName)},</Text>` por `<Greeting name={userName} />`.

O resto do texto desses dois arquivos continua em inglês até a Task 4. Depois disso, o build precisa passar limpo.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/integrations/transactional/partials/partials.tsx apps/server/src/integrations/transactional/emails/page-update-email.tsx apps/server/src/integrations/transactional/emails/page-update-digest-email.tsx
git commit -m "feat(mail): Tessera header, footer and Portuguese greeting"
```

---

### Task 3: Templates de autenticação e convite

Os quatro de maior impacto: são os únicos que bloqueiam alguém de entrar na wiki.

**Files:**
- Modify: `apps/server/src/integrations/transactional/emails/invitation-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/invitation-accepted-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/forgot-password-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/change-password-email.tsx`

**Interfaces:**
- Consumes: `MailBody`, `EmailButton`, `Greeting` de `../partials/partials`; `content`, `paragraph`, `paragraphMuted` de `../css/styles`.
- Nenhuma prop de nenhum template muda. Os services que os chamam continuam iguais.

- [ ] **Step 1: invitation-email.tsx**

Substitua o corpo do componente (mantenha imports, `interface Props` e o `export default`):

```tsx
export const InvitationEmail = ({ inviteLink }: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          Você foi convidado para a Tessera, a base de conhecimento da
          Tessera.
        </Text>
      </Section>
      <EmailButton href={inviteLink}>Aceitar convite</EmailButton>
      <Section style={content}>
        <Text style={paragraphMuted}>
          Você recebeu este e-mail porque alguém da equipe te convidou.
        </Text>
      </Section>
    </MailBody>
  );
};
```

Imports: acrescente `Greeting` e `paragraphMuted`; remova nada.

Não escreva prazo de validade aqui. Convites não expiram — `workspace_invitations` não tem coluna de expiração.

- [ ] **Step 2: invitation-accepted-email.tsx**

```tsx
export const InvitationAcceptedEmail = ({
  invitedUserName,
  invitedUserEmail,
}: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          {invitedUserName} ({invitedUserEmail}) aceitou seu convite e agora faz
          parte do workspace.
        </Text>
      </Section>
    </MailBody>
  );
};
```

"workspace" fica em inglês de propósito: é assim que aparece na interface (`translation.json` traduz `Workspace` como `Workspace`).

- [ ] **Step 3: forgot-password-email.tsx**

```tsx
export const ForgotPasswordEmail = ({ username, resetLink }: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting name={username} />
        <Text style={paragraph}>
          Recebemos um pedido para redefinir sua senha.
        </Text>
      </Section>
      <EmailButton href={resetLink}>Definir nova senha</EmailButton>
      <Section style={content}>
        <Text style={paragraphMuted}>
          O link vale por 30 minutos. Se não foi você que pediu, ignore este
          e-mail.
        </Text>
      </Section>
    </MailBody>
  );
};
```

Duas mudanças além da tradução. O link virou botão — era um `<Link>` solto no meio do texto, mais difícil de achar do que o resto dos e-mails do produto. E os 30 minutos são reais, verificados em `auth.service.ts:197`.

Ajuste os imports: `EmailButton` e `Greeting` de `../partials/partials`; `content`, `paragraph`, `paragraphMuted` de `../css/styles`; remova `Button`, `Link` de `react-email` e `button`, `link` de styles se ficarem sem uso.

- [ ] **Step 4: change-password-email.tsx**

```tsx
export const ChangePasswordEmail = ({ username }: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting name={username} />
        <Text style={paragraph}>Sua senha foi alterada.</Text>
        <Text style={paragraphMuted}>
          Se não foi você, procure um administrador da wiki agora.
        </Text>
      </Section>
    </MailBody>
  );
};
```

A segunda linha não existia no original. Um aviso de senha alterada sem caminho de ação é inútil justamente no caso que importa, que é a conta comprometida.

- [ ] **Step 5: Verificar**

```bash
pnpm --filter server build && npx tsc --noEmit -p apps/server/tsconfig.json
```

Esperado: ambos limpos. Erros de import não usado aparecem aqui.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/integrations/transactional/emails/invitation-email.tsx apps/server/src/integrations/transactional/emails/invitation-accepted-email.tsx apps/server/src/integrations/transactional/emails/forgot-password-email.tsx apps/server/src/integrations/transactional/emails/change-password-email.tsx
git commit -m "feat(mail): translate auth and invitation emails"
```

---

### Task 4: Templates de comentário e página

**Files:**
- Modify: `apps/server/src/integrations/transactional/emails/comment-created-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/comment-mention-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/comment-resolved-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/page-mention-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/page-update-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/page-update-digest-email.tsx`

**Interfaces:**
- Consumes: `MailBody`, `EmailButton`, `Greeting`, `content`, `paragraph`, `link`, `brand`.
- Os dois últimos já tiveram o import de `Greeting` ajustado na Task 2; aqui traduz-se o texto restante.

- [ ] **Step 1: Os quatro de uma linha**

Em cada um, troque `<Text style={paragraph}>Hi there,</Text>` por `<Greeting />`, ajuste o import (`Greeting` em vez de nada; `getGreetingName` não é usado nestes), e troque a frase e o rótulo do botão:

`comment-created-email.tsx`:
```tsx
        <Text style={paragraph}>
          <strong>{actorName}</strong> comentou em{' '}
          <strong>{pageTitle}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Ver comentário</EmailButton>
```

`comment-mention-email.tsx`:
```tsx
        <Text style={paragraph}>
          <strong>{actorName}</strong> mencionou você em um comentário em{' '}
          <strong>{pageTitle}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Ver comentário</EmailButton>
```

`comment-resolved-email.tsx`:
```tsx
        <Text style={paragraph}>
          <strong>{actorName}</strong> resolveu um comentário em{' '}
          <strong>{pageTitle}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Ver página</EmailButton>
```

`page-mention-email.tsx`:
```tsx
        <Text style={paragraph}>
          <strong>{actorName}</strong> mencionou você em{' '}
          <strong>{pageTitle}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Ver página</EmailButton>
```

- [ ] **Step 2: page-update-email.tsx**

```tsx
        <Greeting name={userName} />
        <Text style={paragraph}>
          <strong>{actorName}</strong> atualizou{' '}
          <Link href={pageUrl} style={link}>
            <strong>{pageTitle}</strong>
          </Link>{' '}
          no espaço <strong>{spaceName}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Ver página</EmailButton>
```

- [ ] **Step 3: page-update-digest-email.tsx**

Corpo:

```tsx
        <Greeting name={userName} />
        <Text style={paragraph}>
          {/* Portuguese "houve" is invariant, so unlike the English original
              only the noun needs pluralising. */}
          Houve{' '}
          <strong>
            {totalUpdates} atualiza{totalUpdates === 1 ? 'ção' : 'ções'}
          </strong>{' '}
          desde o último resumo.
        </Text>
```

E o rótulo de autoria:

```tsx
              <Text style={updatedByText}>
                Editado por {page.updatedBy.join(', ')}
              </Text>
```

Atualize também os estilos locais no fim do arquivo, que têm cores literais fora dos tokens:

```tsx
const pageCard = {
  borderLeft: `3px solid ${brand.yellow}`,
  paddingLeft: '12px',
  marginBottom: '12px',
};

const pageTitle = {
  ...paragraph,
  margin: '0 0 2px 0',
  fontSize: 14,
  fontWeight: 500,
};

const updatedByText = {
  ...paragraph,
  margin: '0',
  fontSize: 13,
  color: brand.greyText,
};
```

Acrescente `brand` ao import de `../css/styles`. A borda esquerda era `#e8e5ef` (lilás do Tessera); passa a ser o amarelo da Tessera, que é o único acento de cor do e-mail.

- [ ] **Step 4: Verificar**

```bash
pnpm --filter server build && npx tsc --noEmit -p apps/server/tsconfig.json
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/integrations/transactional/emails/
git commit -m "feat(mail): translate comment and page notification emails"
```

---

### Task 5: Templates de permissão e verificação

**Files:**
- Modify: `apps/server/src/integrations/transactional/emails/permission-granted-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/approval-requested-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/approval-rejected-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/verification-expiring-email.tsx`
- Modify: `apps/server/src/integrations/transactional/emails/verification-expired-email.tsx`

**Interfaces:**
- Consumes: `MailBody`, `EmailButton`, `Greeting`, `content`, `paragraph`.
- Depende de: a prop `accessLabel` de `permission-granted-email.tsx` passa a receber `'edição'` ou `'leitura'` em vez de `'edit'`/`'view'`. Quem produz esse valor é `page.notification.ts:149`, alterado na Task 6. Até lá o template renderiza o rótulo em inglês dentro de uma frase em português — esperado, não é defeito.

- [ ] **Step 1: permission-granted-email.tsx**

```tsx
        <Greeting />
        <Text style={paragraph}>
          <strong>{actorName}</strong> concedeu acesso de {accessLabel} a{' '}
          <strong>{pageTitle}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Ver página</EmailButton>
```

- [ ] **Step 2: approval-requested-email.tsx**

```tsx
        <Greeting />
        <Text style={paragraph}>
          <strong>{actorName}</strong> enviou <strong>{pageTitle}</strong>, no
          espaço <strong>{spaceName}</strong>, para sua aprovação.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Revisar página</EmailButton>
```

- [ ] **Step 3: approval-rejected-email.tsx**

```tsx
        <Greeting />
        <Text style={paragraph}>
          <strong>{actorName}</strong> devolveu <strong>{pageTitle}</strong>, no
          espaço <strong>{spaceName}</strong>, para revisão.
        </Text>
        {comment && (
          <Text style={{ ...paragraph, fontStyle: 'italic' }}>
            &ldquo;{comment}&rdquo;
          </Text>
        )}
      </Section>
      <EmailButton href={pageUrl}>Ver página</EmailButton>
```

- [ ] **Step 4: verification-expiring-email.tsx**

```tsx
        <Greeting />
        <Text style={paragraph}>
          A página <strong>{pageTitle}</strong>, no espaço{' '}
          <strong>{spaceName}</strong>, precisa ser verificada de novo. A
          verificação expira em <strong>{expiresAt}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Revisar página</EmailButton>
```

- [ ] **Step 5: verification-expired-email.tsx**

```tsx
        <Greeting />
        <Text style={paragraph}>
          A verificação de <strong>{pageTitle}</strong>, no espaço{' '}
          <strong>{spaceName}</strong>, expirou. Verifique a página de novo para
          confirmar que continua correta.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Verificar novamente</EmailButton>
```

- [ ] **Step 6: Verificar**

```bash
pnpm --filter server build && npx tsc --noEmit -p apps/server/tsconfig.json
```

Confirme que nenhum "Hi there" sobrou nos templates:

```bash
grep -rn "Hi there\|getGreetingName" apps/server/src/integrations/transactional/
```

Esperado: nenhuma saída.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/integrations/transactional/emails/
git commit -m "feat(mail): translate permission and verification emails"
```

---

### Task 6: Assuntos nos services

Assunto em inglês com corpo em português é o pior dos dois mundos: é o assunto que aparece na listagem da caixa de entrada.

**Files:**
- Modify: `apps/server/src/core/auth/services/auth.service.ts:165,213,274`
- Modify: `apps/server/src/core/workspace/services/workspace-invitation.service.ts:331,480`
- Modify: `apps/server/src/core/notification/services/verification.notification.ts:120,194,262,307`
- Modify: `apps/server/src/core/notification/services/page.notification.ts:120,149,163`
- Modify: `apps/server/src/core/notification/services/comment.notification.ts:180`

**Interfaces:**
- Produces: `accessLabel` em `page.notification.ts:149` passa a valer `'edição'` ou `'leitura'`, consumido pelo template da Task 5 e pelo assunto na linha 163.

- [ ] **Step 1: auth.service.ts**

Linha 165 e linha 274, ambas iguais:
```ts
      subject: 'Sua senha foi alterada',
```

Linha 213:
```ts
      subject: 'Redefinir sua senha',
```

- [ ] **Step 2: workspace-invitation.service.ts**

Linha 331:
```ts
        subject: `${newUser.name} aceitou seu convite para a Tessera`,
```

Linha 480:
```ts
      subject: `${invitedByName} convidou você para a Tessera`,
```

- [ ] **Step 3: verification.notification.ts**

Linha 120:
```ts
      const subject = `"${pageTitle}" precisa ser verificada de novo`;
```

Linha 194:
```ts
      const subject = `A verificação de "${pageTitle}" expirou`;
```

Linha 262:
```ts
      const subject = `"${pageTitle}" aguarda sua aprovação`;
```

Linha 307:
```ts
    const subject = `"${pageTitle}" foi devolvida para revisão`;
```

- [ ] **Step 4: page.notification.ts**

Linha 120:
```ts
      const subject = `${actor.name} mencionou você em ${pageTitle}`;
```

Linha 149 — o rótulo que também alimenta o template:
```ts
    const accessLabel = role === 'writer' ? 'edição' : 'leitura';
```

Linha 163:
```ts
      const subject = `${actor.name} deu acesso de ${accessLabel} a ${pageTitle}`;
```

- [ ] **Step 5: comment.notification.ts**

Linha 180:
```ts
    const subject = `${actor.name} resolveu um comentário em ${pageTitle}`;
```

- [ ] **Step 6: Varrer o que sobrou**

Os números de linha acima são do estado em `865003fd` e podem ter deslocado. Além disso, pode haver assunto que não estava no levantamento — comentário criado e menção em comentário, por exemplo, podem construir o assunto por outro caminho. Rode:

```bash
grep -rn "subject" apps/server/src/core --include=*.ts | grep -v spec | grep -v "subject," | grep -v "subject:$"
```

Leia cada linha e confirme que nenhuma string de assunto ficou em inglês. Se encontrar alguma não listada, traduza seguindo o mesmo tom e registre no relatório.

- [ ] **Step 7: Verificar**

```bash
pnpm --filter server build && npx tsc --noEmit -p apps/server/tsconfig.json
```

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/core/
git commit -m "feat(mail): translate email subjects"
```

---

### Task 7: Conferência visual dos 15

O build não diz nada sobre como o e-mail fica. Os templates não são cobertos por jest — o stub em `apps/server/package.json` os substitui, decisão registrada no spec. Esta task é a única verificação real do resultado.

**Files:** nenhum, salvo correções que a conferência revelar.

- [ ] **Step 1: Subir o preview**

```bash
pnpm --filter server email:dev
```

Abre em `http://localhost:5019` renderizando `./src/integrations/transactional/emails`.

- [ ] **Step 2: Conferir cada um dos 15**

Para cada template, verifique:

- texto todo em português, sem sobra de inglês;
- saudação lendo "Olá" ou "Olá, Nome" — nunca "Olá, there" nem "Olá, ";
- botão amarelo com texto preto, em pílula;
- linhas com respiro entre si (o `lineHeight: 1.6` aplicado);
- cabeçalho mostrando logo e o nome "Tessera";
- rodapé com "Tessera · base de conhecimento da Tessera".

O logo provavelmente **não** vai aparecer no preview: `process.env.APP_URL` não está definido no ambiente de desenvolvimento, então o `src` fica relativo e quebra. Isso é esperado e não é defeito — o que precisa aparecer é o texto "Tessera" logo abaixo, que é justamente a alternativa para quem bloqueia imagem. Para ver o logo, rode com a variável:

```bash
APP_URL=https://wiki.cledson.com.br pnpm --filter server email:dev
```

- [ ] **Step 3: Varredura final de inglês**

```bash
grep -rniE "\b(Hi there|Please|click|View page|Review page|Accept|invited you|has been changed|expired|approval)\b" apps/server/src/integrations/transactional/emails/
```

Esperado: nenhuma saída. Palavras dentro de nomes de componente e de props (`ApprovalRejectedEmail`, `pageUrl`) não contam — o comando acima usa limites de palavra, mas confira o que sair antes de concluir.

- [ ] **Step 4: Commit de eventuais correções**

```bash
git add -A
git commit -m "fix(mail): corrections from template preview"
```

Se a conferência não revelar nada, não há commit nesta task — registre isso no relatório.

---

## Fechamento

- [ ] Atualizar `docs/ai-context/` se algum arquivo descrever os e-mails em inglês: `grep -rn "email" docs/ai-context/`.
- [ ] Push e deploy ficam a critério do usuário. Lembre que um push em `main` dispara deploy para produção.
- [ ] Teste fim a fim depois do deploy: "esqueci minha senha" na tela de login entrega um e-mail real, com assunto e corpo em português, sem precisar criar convite.

## Fora de escopo

Infraestrutura de envio, já resolvida em `865003fd`. Versão em inglês dos templates. Preferências de assinatura. Notificações in-app. Qualquer mudança nos services além da string de assunto e do `accessLabel`.
