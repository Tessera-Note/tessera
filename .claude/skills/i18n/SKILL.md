---
name: i18n
description: Working with the localization dictionaries of the project. Applies when adding user-facing text, editing translations, substituting values into a string and checking the consistency of the dictionaries.
---

# Localization

## When to apply this

Text that a person sees is being added to or changed in the interface. Or you
need to understand where the translations come from and why a string exists in
one language and not in another.

## How it is built

- the dictionaries are `apps/web/static/locales/<locale>.json`, one file per
  locale
- there is no library: loading, substitution and number forms live in
  `apps/web/src/lib/i18n/index.ts`
- the fallback language is `en-US`
- 12 locales: `de-DE`, `en-US`, `es-ES`, `fr-FR`, `it-IT`, `ja-JP`, `ko-KR`,
  `nl-NL`, `pt-BR`, `ru-RU`, `uk-UA`, `zh-CN`

## The main difference from the usual scheme

The dictionary is flat, there are no namespaces, and the key is a whole English
phrase.

```json
{
  "Add members": "Добавить участников",
  "Are you sure you want to delete this group?": "Вы уверены, что хотите удалить эту группу?"
}
```

In `en-US` the key and the value are the same. There are no keys like
`group.deleteConfirmTitle` here, and there is no need to invent them. There is
one exception — the failure codes (`error.*`), which come from the server.

## Adding text

```svelte
<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';
  const t = $derived(locale.t);
</script>

<Button>{t('Add members')}</Button>
```

1. Write the phrase in English right inside the `t()` call
2. Add the same phrase as both key and value to `en-US.json`, keeping the order
   of the neighbouring keys
3. Translate the key **in all twelve dictionaries at once**: synchronization is
   off (`crowdin.yml`), there is nobody else to fill them in, and an untranslated
   key is shown to a person as the English phrase
4. Run `pnpm --filter @tessera/web test dictionaries`: the key sets must match

## Substituting values

Double curly braces. An unknown name stays visible rather than turning into
nothing.

```json
{ "Deleted {{count}} pages": "Удалено страниц: {{count}}" }
```

```ts
t('Deleted {{count}} pages', { count: pages.length })
```

Single braces `{count}` are not seen by the substitution.

## Number forms

If the values contain a numeric `count`, the translation goes **straight into a
form** and the base key is not used.

- the form is chosen by `Intl.PluralRules` by the rules of the language, not by
  a home-made calculation
- English and the rest: `_one`, `_other`; in `ja-JP`, `ko-KR` and `zh-CN` both
  forms are the same; in French and Portuguese zero goes into `_one`
- the Slavic ones (`ru-RU`, `uk-UA`): `_one`, `_few`, `_many` and `_other` — the
  last one for fractional numbers ("1.5 files"); the dictionary test requires all
  four

```json
{
  "{{count}} pages_one": "{{count}} страница",
  "{{count}} pages_few": "{{count}} страницы",
  "{{count}} pages_many": "{{count}} страниц",
  "{{count}} pages_other": "{{count}} страницы"
}
```

When creating a plural key, create **all** the forms of your language, and do
not create the base key with no suffix: with a number it is never read. `_few`
and `_many` are not used by the other languages.

## Failure codes

The server does not send ready text. It sends a code
(`error.auth.session_expired`), and the dictionary expands it.

The trap: **a code must not end with a number form suffix** (`_one`, `_few`,
`_many`, `_other`) — the parser would take the tail for a form and would not
find the translation.

A new code is created in `apps/api/tessera_api/domain/errors.py` and in the
twelve dictionaries. The correspondence is checked by
`apps/web/src/lib/i18n/error-codes.test.ts`.

## The rules

- a key must be present in `en-US`, otherwise a raw key appears on the screen
- a key is not created and not left behind without code using it: the reverse
  check looks for it in the code as a whole quoted string (part of another string
  does not count), and a lowercase word key (`days`, `member`) only as a
  translation argument, `t('days')` or `translate('days')`, because words like
  that coincide with values in the code
- the key sets in all twelve dictionaries must match
- one and the same phrase is not created under two keys
- numbers and dates are formatted through `Intl.NumberFormat` and
  `Intl.DateTimeFormat` rather than by a translation in the dictionary
- the language is not used as a flag in the logic. A condition like `if (lang ===
  'ru')` is a sign of a wrong decision
- technical strings are not translated: class names, `data-*` attributes, enum
  values, messages for developers

## Mail

Mail is assembled on the application side, where the dictionaries of the screens
do not exist. It has its own catalogue of the same shape:
`apps/api/tessera_api/infrastructure/mail_text.py`, the same twelve languages,
the same double braces, English as the fallback.

When editing a letter, edit the mail catalogue rather than the dictionary of the
screens.

A separate caveat from there: the word for the kind of access is substituted into
a sentence, and every language builds the sentence its own way. Keys like that
must not be translated in isolation from the sentence.

## Verification

```
pnpm --filter @tessera/web test dictionaries
pnpm --filter @tessera/web test error-codes
```

Then the `i18n-reviewer` agent. It compares the keys from the code against the
dictionary, finds hard-wired texts and broken substitution.

## Antipatterns

- a `namespace.camelCase` style key for ordinary text
- adding a key only to `ru-RU`, bypassing `en-US`
- a plural key missing some of the forms of its language
- a failure code ending in `_one` or `_many`
- a bulk edit of the dictionaries with `sed` and no check of the JSON structure
  afterwards
- an empty value `"key": ""`
