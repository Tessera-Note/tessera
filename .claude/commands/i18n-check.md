---
description: Checking the consistency of the localization dictionaries
---

Check the localization.

## Step 1. Valid JSON

```
for l in de-DE en-US es-ES fr-FR it-IT ja-JP ko-KR nl-NL pt-BR ru-RU uk-UA zh-CN; do
  node -e "JSON.parse(require('fs').readFileSync('apps/web/static/locales/$l.json','utf8')); console.log('$l ok')"
done
```

## Step 2. Consistency of the key sets

```
pnpm --filter @tessera/web test dictionaries
```

The test `apps/web/src/lib/i18n/dictionaries.test.ts` compares the key sets
across all twelve dictionaries. For reference: 1144 keys in ten locales and 1156
in `ru-RU` and `uk-UA` — the difference is the Slavic `_few` and `_many` forms of
six plural families.

Separately, `error-codes.test.ts` checks that every failure code the application
serves is expanded into text by the dictionary.

## Step 3. A deeper analysis

Run the `i18n-reviewer` agent. It will check:

- keys used in the code and missing from `en-US`; that is a blocker
- hard-wired user-facing texts in components that already take a translation
  nearby
- broken substitution: a variable in a value that is not passed from the code, or
  the other way round
- a divergence of the plural forms between locales
- duplicates of one phrase under different keys

## Step 4. The report

Show the agent's result to the user. Do not translate anything yourself: editing
a dictionary is a separate action, and it is done by whoever asked for the check.

Translation synchronization is off (`crowdin.yml`) and the dictionaries are kept
in the repository. Any dictionary is edited directly, and there is nothing left
that would overwrite it.
