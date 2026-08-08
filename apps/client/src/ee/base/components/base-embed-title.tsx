import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDebouncedCallback } from "@mantine/hooks";
import {
  usePageQuery,
  useUpdateTitlePageMutation,
  updatePageData,
} from "@/features/page/queries/page-query";
import localEmitter from "@/lib/local-emitter";
import classes from "@/ee/base/styles/grid.module.css";

// Editable base name for the inline embed. Local cache and tree updates mirror
// the page TitleEditor; the server broadcasts refreshes to other clients.
export function BaseEmbedTitle({ pageId }: { pageId: string }) {
  const { t } = useTranslation();
  const { data: page } = usePageQuery({ pageId });
  const { mutateAsync: updateTitleAsync } = useUpdateTitlePageMutation();
  const [value, setValue] = useState("");
  const focusedRef = useRef(false);

  // Keep in sync with the persisted title but never clobber active user input.
  useEffect(() => {
    if (!focusedRef.current) setValue(page?.title ?? "");
  }, [page?.title]);

  const commit = useCallback(() => {
    const trimmed = value.trim();
    if (!page || trimmed === (page.title ?? "")) return;

    // Пустое имя не сохраняется никогда.
    //
    // `value` инициализируется пустой строкой, а подтягивается из загруженной
    // страницы только когда поле не в фокусе. При перемонтировании
    // компонента с полем в фокусе синхронизация не происходит, и
    // принудительное сохранение на размонтировании затирало введенное имя
    // пустой строкой. Это потеря данных, и защита от нее не зависит от того,
    // почему компонент перемонтировался.
    //
    // Цена: очистить имя базы до пустого через это поле нельзя. Она мала,
    // потому что пустое имя все равно показывается placeholder-ом, а обмен
    // возможности очистки на невозможность молча потерять введенное выгоден.
    if (!trimmed) return;
    updateTitleAsync({ pageId, title: trimmed }).then((updated) => {
      if (updated.title !== trimmed) return;
      const localUpdate = {
        id: updated.id,
        payload: {
          title: updated.title,
          slugId: updated.slugId,
          parentPageId: updated.parentPageId,
          icon: updated.icon,
        },
      };
      updatePageData(updated);
      localEmitter.emit("message", localUpdate);
    });
  }, [value, page, pageId, updateTitleAsync]);

  const debouncedCommit = useDebouncedCallback(commit, 500);

  // Force-save any pending edit on unmount (e.g. navigating away mid-type).
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);
  useEffect(() => () => commitRef.current(), []);

  return (
    <input
      className={classes.embedTitleInput}
      value={value}
      placeholder={t("Untitled base")}
      aria-label={t("Base name")}
      onChange={(e) => {
        setValue(e.currentTarget.value);
        debouncedCommit();
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setValue(page?.title ?? "");
          e.currentTarget.blur();
        }
      }}
    />
  );
}
