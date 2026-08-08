import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import Backend from "i18next-http-backend";
import { setMediaErrorLabels } from "@tessera/editor-ext";

i18n
  // load translation using http -> see /public/locales (i.e. https://github.com/i18next/react-i18next/tree/master/example/react/public/locales)
  // learn more: https://github.com/i18next/i18next-http-backend
  // want your translations to be loaded from a professional CDN? => https://github.com/locize/react-tutorial#step-2---use-the-locize-cdn
  .use(Backend)
  // pass the i18n instance to react-i18next.
  .use(initReactI18next)
  // init i18next
  // for all options read: https://www.i18next.com/overview/configuration-options
  .init({
    fallbackLng: "en-US",
    debug: false,
    showSupportNotice: false,
    load: 'currentOnly',

    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },
    react: {
      useSuspense: false,
    }
  });

export default i18n;

/**
 * Тексты для недоступных вложений.
 *
 * Узлы `image`, `video`, `drawio` и `excalidraw` рисуются обычным DOM в
 * пакете расширений, который про i18next не знает. Строки отдаются ему
 * отсюда и обновляются при смене языка.
 */
function publishMediaErrorLabels() {
  setMediaErrorLabels({
    missing: i18n.t("This file no longer exists. It may have been deleted."),
    forbidden: i18n.t("You don't have access to this file."),
    failed: i18n.t("Failed to load this file."),
  });
}

i18n.on("initialized", publishMediaErrorLabels);
i18n.on("languageChanged", publishMediaErrorLabels);
i18n.on("loaded", publishMediaErrorLabels);
