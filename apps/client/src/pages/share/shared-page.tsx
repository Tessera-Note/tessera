import { useNavigate, useParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { useSharePageQuery } from "@/features/share/queries/share-query.ts";
import { Button, Container } from "@mantine/core";
import React, { useEffect } from "react";
import { extractPageSlugId } from "@/lib";
import { Error404 } from "@/components/ui/error-404.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import ShareBranding from "@/features/share/components/share-branding.tsx";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { ErrorBoundary } from "react-error-boundary";
import {
  sharedPageFullWidthAtom,
  sharedTreeDataAtom,
} from "@/features/share/atoms/shared-page-atom.ts";
import { isPageInTree } from "@/features/share/utils.ts";

// Импорт статический, см. комментарий в pages/page/page.tsx: ленивый редактор
// внутри границы Suspense, которая монтируется вместе со страницей, в
// production-сборке навсегда остается в fallback. Здесь fallback пустой, и
// страница выглядела просто без содержимого.
import ReadonlyPageEditor from "@/features/editor/readonly-page-editor.tsx";

export default function SharedPage() {
  const { t } = useTranslation();
  const { pageSlug } = useParams();
  const { shareId } = useParams();
  const navigate = useNavigate();

  const { data, isLoading, isError, error } = useSharePageQuery({
    pageId: extractPageSlugId(pageSlug),
  });

  const sharedTreeData = useAtomValue(sharedTreeDataAtom);
  const fullWidth = useAtomValue(sharedPageFullWidthAtom);

  useEffect(() => {
    if (shareId && data) {
      if (data.share.key !== shareId) {

        // Check if the current page is part of the active sharing tree (sidebar) - If we are part of it, we will not redirect, keeping the sidebar visible.
        const isPartOfTree =
          sharedTreeData && isPageInTree(sharedTreeData, data.page.slugId);

        if (!isPartOfTree) {
          navigate(`/share/${data.share.key}/p/${pageSlug}`, { replace: true });
        }
      }
    }
  }, [shareId, data, sharedTreeData]);

  if (isLoading) {
    return <></>;
  }

  if (isError || !data) {
    if ([401, 403, 404].includes(error?.["status"])) {
      return <Error404 />;
    }
    return <div>{t("Error fetching page data.")}</div>;
  }

  return (
    <div>
      <Helmet>
        <title>{`${data?.page?.title || t("untitled")}`}</title>
        {!data?.share.searchIndexing && (
          <meta name="robots" content="noindex" />
        )}
      </Helmet>

      <Container fluid={fullWidth} size={fullWidth ? undefined : 900} p={0}>
        <ErrorBoundary
          resetKeys={[data.page.id]}
          fallbackRender={() => (
            <EmptyState
              icon={IconAlertTriangle}
              title={t("Failed to load page. An error occurred.")}
              action={
                <Button
                  variant="default"
                  size="sm"
                  mt="xs"
                  onClick={() => window.location.reload()}
                >
                  {t("Try again")}
                </Button>
              }
            />
          )}
        >
          <React.Suspense
            fallback={<div role="status" aria-label={t("Loading page content")} />}
          >
            <ReadonlyPageEditor
              key={data.page.id}
              title={data.page.title}
              content={data.page.content}
              pageId={data.page.id}
              shareId={data.share.id}
            />
          </React.Suspense>
        </ErrorBoundary>
      </Container>

      {data && !shareId && !(data.features?.length > 0) && <ShareBranding />}
    </div>
  );
}
