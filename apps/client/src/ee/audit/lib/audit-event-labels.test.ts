import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  auditEventLabels,
  eventFilterOptions,
} from "@/ee/audit/lib/audit-event-labels";

/**
 * Метка события служит ключом перевода: таблица журнала показывает
 * `t(getEventLabel(event))`. Ключ, которого нет в источнике, i18next вернет
 * как есть, и человек увидит английскую фразу.
 *
 * Общая проверка словарей этого не ловит. Она читает литералы, объявленные
 * полями `label`, `title` и подобными, а карта событий задана ключами вида
 * `user.deleted`, и правка одной только карты проходит мимо нее. Проверено
 * мутацией: подмена значения в карте общую проверку не роняла.
 */
const source: Record<string, string> = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../../public/locales/en-US/translation.json",
    ),
    "utf8",
  ),
);

describe("метки журнала аудита", () => {
  it("карта событий заведена в источнике", () => {
    const missing = Object.entries(auditEventLabels)
      .filter(([, label]) => !(label in source))
      .map(([event, label]) => `${event}: ${label}`);

    expect(missing).toEqual([]);
  });

  it("подписи фильтра заведены в источнике", () => {
    const missing: string[] = [];

    for (const group of eventFilterOptions) {
      if (!(group.group in source)) missing.push(`группа: ${group.group}`);
      for (const item of group.items) {
        if (!(item.label in source))
          missing.push(`${item.value}: ${item.label}`);
      }
    }

    expect(missing).toEqual([]);
  });

  /**
   * Фраза метки обязана быть своей. Совпав со строкой другого экрана, метка
   * получает ее перевод, написанный под другой смысл: событие удаления
   * участника читалось как «Удаленный пользователь».
   */
  it("метка и подпись фильтра для события совпадают", () => {
    const mismatched: string[] = [];

    for (const group of eventFilterOptions) {
      for (const item of group.items) {
        const label = auditEventLabels[item.value];
        if (label && label !== item.label) {
          mismatched.push(`${item.value}: ${label} против ${item.label}`);
        }
      }
    }

    expect(mismatched).toEqual([]);
  });
});
