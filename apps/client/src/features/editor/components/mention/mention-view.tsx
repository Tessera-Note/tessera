import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { ActionIcon, Anchor, Text } from "@mantine/core";
import { IconFileDescription } from "@tabler/icons-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { useSharePageQuery } from "@/features/share/queries/share-query.ts";
import {
  buildPageUrl,
  buildSharedPageUrl,
} from "@/features/page/page.utils.ts";
import { extractPageSlugId } from "@/lib";
import { getApiErrorStatus } from "@/lib/api-error";
import { useMentionUserQuery } from "@/features/user/queries/mention-query";
import { useTranslation } from "react-i18next";
import classes from "./mention.module.css";

export default function MentionView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { node } = props;
  const { label, entityType, entityId, slugId, anchorId } = node.attrs;
  const isPageMention = entityType === "page";
  const { spaceSlug, pageSlug } = useParams();
  const { shareId } = useParams();
  const navigate = useNavigate();

  const location = useLocation();
  const isShareRoute = location.pathname.startsWith("/share");

  const {
    data: page,
    isLoading,
    isError,
    error,
  } = usePageQuery({ pageId: isPageMention && !isShareRoute ? slugId : null });

  // Сервер эти случаи различает: 404, когда страницы нет, и 403, когда нет
  // прав. Подпись в узле заморожена на момент вставки, поэтому без пометки
  // упоминание исчезнувшей страницы выглядит рабочей ссылкой с актуальным
  // заголовком, и человек узнает правду только кликнув.
  const missing = getApiErrorStatus(error) === 404;

  const { data: sharedPage } = useSharePageQuery({
    pageId: isPageMention && isShareRoute ? slugId : undefined,
  });

  const currentPageSlugId = extractPageSlugId(pageSlug);
  const isSamePage = currentPageSlugId === slugId;

  const handleClick = (e: React.MouseEvent) => {
    if (isSamePage && anchorId) {
      e.preventDefault();
      const element = document.querySelector(`[id="${anchorId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "start" });
        navigate(`#${anchorId}`, { replace: true });
      }
    }
  };

  // Подпись упоминания человека заморожена на момент вставки, поэтому имя
  // удаленного оставалось в теле каждой страницы, где его упомянули, а
  // отключенный и действующий выглядели одинаково. Разрешаем на лету.
  const isUserMention = entityType === "user";
  const {
    data: mentionedUser,
    isLoading: isUserLoading,
    isError: isUserError,
  } = useMentionUserQuery(isUserMention ? entityId : undefined);

  // Пока не ответили или ответ не пришел вовсе, показывается прежняя подпись:
  // сеть не должна превращать упоминание в «удален».
  const userIsGone =
    isUserMention && !isUserLoading && !isUserError && !mentionedUser;
  const userLabel = userIsGone
    ? t("Deleted user")
    : (mentionedUser?.name ?? label);

  const sharePageTitle = sharedPage?.page?.title || label;

  const shareSlugUrl = buildSharedPageUrl({
    shareId,
    pageSlugId: slugId,
    pageTitle: sharePageTitle,
    anchorId,
  });

  return (
    <NodeViewWrapper style={{ display: "inline" }} data-drag-handle>
      {isUserMention && (
        <Text
          className={classes.userMention}
          component="span"
          c={userIsGone || mentionedUser?.deactivated ? "dimmed" : undefined}
          title={
            userIsGone
              ? t("This account no longer exists.")
              : mentionedUser?.deactivated
                ? t("This account is deactivated.")
                : undefined
          }
        >
          @{userLabel}
        </Text>
      )}

      {isPageMention && isShareRoute && (
        <Anchor
          component={Link}
          fw={500}
          to={shareSlugUrl}
          onClick={handleClick}
          underline="never"
          className={classes.pageMentionLink}
        >
          <ActionIcon
            variant="transparent"
            color="gray"
            component="span"
            size={18}
            style={{ verticalAlign: "text-bottom" }}
          >
            <IconFileDescription size={18} />
          </ActionIcon>
          <span className={classes.pageMentionText}>{sharePageTitle}</span>
        </Anchor>
      )}

      {isPageMention && !isShareRoute && isError && missing && (
        // Ссылки нет: вести некуда. Узел остается в содержимом как есть и
        // правке не мешает, но виден как недоступный, а не как рабочий.
        <Text
          component="span"
          c="dimmed"
          fw={500}
          td="line-through"
          title={t("This page no longer exists. It may have been deleted.")}
        >
          <ActionIcon
            variant="transparent"
            color="gray"
            component="span"
            size={18}
            style={{ verticalAlign: "text-bottom" }}
          >
            <IconFileDescription size={18} />
          </ActionIcon>
          {label}
        </Text>
      )}

      {isPageMention && !isShareRoute && isError && !missing && (
        // Страница есть, но закрыта правами: ссылка остается кликабельной,
        // человек может попросить доступ.
        <Anchor
          component={Link}
          fw={500}
          to={buildPageUrl(spaceSlug, slugId, label, anchorId)}
          onClick={handleClick}
          underline="never"
          className={classes.pageMentionLink}
          title={t("You don't have access to this page.")}
        >
          <ActionIcon
            variant="transparent"
            color="gray"
            component="span"
            size={18}
            style={{ verticalAlign: "text-bottom" }}
          >
            <IconFileDescription size={18} />
          </ActionIcon>
          <span className={classes.pageMentionText}>{label}</span>
        </Anchor>
      )}

      {isPageMention && !isShareRoute && !isError && (
        <Anchor
          component={Link}
          fw={500}
          to={buildPageUrl(
            page?.space?.slug || spaceSlug,
            slugId,
            page?.title || label,
            anchorId,
          )}
          onClick={handleClick}
          underline="never"
          className={classes.pageMentionLink}
        >
          {page?.icon ? (
            <span style={{ marginRight: "4px" }}>{page.icon}</span>
          ) : (
            <ActionIcon
              variant="transparent"
              color="gray"
              component="span"
              size={18}
              style={{ verticalAlign: "text-bottom" }}
            >
              <IconFileDescription size={18} />
            </ActionIcon>
          )}

          <span className={classes.pageMentionText}>
            {page?.title || label}
          </span>
        </Anchor>
      )}
    </NodeViewWrapper>
  );
}
