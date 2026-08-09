import classes from "@/features/editor/styles/editor.module.css";
import React, { useEffect } from "react";
import { TitleEditor } from "@/features/editor/title-editor";
import ReadonlyPageEditor from "@/features/editor/readonly-page-editor";
// Импорт статический, см. комментарий в pages/page/page.tsx: через React.lazy
// граница Suspense в production-сборке навсегда оставалась в fallback.
import PageEditor from "@/features/editor/page-editor";
import {
  ActionIcon,
  Container,
  Divider,
  Group,
  Popover,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useAtom, useAtomValue } from "jotai";
import { userAtom } from "@/features/user/atoms/current-user-atom.ts";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { PageVerificationBadge } from "@/ee/page-verification";
import { useTranslation } from "react-i18next";
import { IContributor } from "@/features/page/types/page.types.ts";
import { FixedToolbar } from "@/features/editor/components/fixed-toolbar/fixed-toolbar";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import { useAsideTriggerProps } from "@/hooks/use-toggle-aside.tsx";
import { DeletedPageBanner } from "@/features/page/trash/components/deleted-page-banner.tsx";
import clsx from "clsx";
import {
  collabAccessAtom,
  currentPageEditModeAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import { EmptyPageGetStarted } from "@/features/editor/components/empty-page/empty-page-get-started";

const MemoizedTitleEditor = React.memo(TitleEditor);
const MemoizedReadonlyPageEditor = React.memo(ReadonlyPageEditor);
const MemoizedFixedToolbar = React.memo(FixedToolbar);
const MemoizedDeletedPageBanner = React.memo(DeletedPageBanner);

type PageUser = {
  id: string;
  name: string;
  avatarUrl: string;
};

// Module-level flag: survives component unmount/remount on page navigation,
// reset only on full page reload (i.e. a new app session).
let defaultEditModeApplied = false;

export interface FullEditorProps {
  pageId: string;
  slugId: string;
  title: string;
  content: string;
  spaceSlug: string;
  editable: boolean;
  creator?: PageUser;
  contributors?: IContributor[];
  canComment?: boolean;
}

export function FullEditor({
  pageId,
  title,
  slugId,
  content,
  spaceSlug,
  editable,
  creator,
  contributors,
  canComment,
}: FullEditorProps) {
  const [user] = useAtom(userAtom);
  const fullPageWidth = user.settings?.preferences?.fullPageWidth;
  const editorToolbarEnabled =
    user.settings?.preferences?.editorToolbar ?? false;
  const [currentPageEditMode, setCurrentPageEditMode] = useAtom(
    currentPageEditModeAtom,
  );
  const userPageEditMode =
    user.settings?.preferences?.pageEditMode ?? PageEditMode.Edit;
  /**
   * Права, отозванные или пониженные уже после загрузки страницы.
   *
   * `editable` приходит из данных, полученных при открытии, и после отзыва
   * прав на живом соединении остается устаревшим. Заголовок и тело это два
   * разных редактора, поэтому поправка применяется здесь, в общем для них
   * месте, а не внутри одного из них.
   */
  const collabAccess = useAtomValue(collabAccessAtom);
  const effectiveEditable =
    editable && !collabAccess.revoked && !collabAccess.readOnly;
  // The atom is initialized to Edit and the saved preference is applied in an
  // effect. Use that preference during the initial render so View mode never
  // starts loading the collaboration editor before the effect runs.
  const isEditMode =
    (defaultEditModeApplied ? currentPageEditMode : userPageEditMode) ===
    PageEditMode.Edit;
  // Inline comments need PageEditor's synced Yjs binding to create relative
  // selections, so commenters retain the collaborative editor in View mode.
  const needsCollaborativeEditor = canComment || (editable && isEditMode);

  // Apply the user's saved preference only once on initial load, not on every
  // page navigation — so the mode sticks across navigations within a session.
  useEffect(() => {
    if (!defaultEditModeApplied) {
      setCurrentPageEditMode(userPageEditMode as PageEditMode);
      defaultEditModeApplied = true;
    }
  }, [userPageEditMode, setCurrentPageEditMode]);

  return (
    <Container
      fluid={fullPageWidth}
      size={!fullPageWidth && 900}
      className={classes.editor}
      style={{ display: "flex", flexDirection: "column" }}
    >
      {editorToolbarEnabled && effectiveEditable && isEditMode && (
        <MemoizedFixedToolbar />
      )}
      <MemoizedDeletedPageBanner slugId={slugId} />
      <MemoizedTitleEditor
        pageId={pageId}
        slugId={slugId}
        title={title}
        spaceSlug={spaceSlug}
        editable={effectiveEditable}
      />
      <PageByline
        creator={creator}
        contributors={contributors}
        readOnly={!effectiveEditable}
      />
      {needsCollaborativeEditor ? (
        <React.Suspense fallback={null}>
          <PageEditor
            pageId={pageId}
            editable={effectiveEditable}
            content={content}
            canComment={canComment}
          />
          <EmptyPageGetStarted pageId={pageId} editable={effectiveEditable} />
        </React.Suspense>
      ) : (
        <MemoizedReadonlyPageEditor
          title={title}
          content={content}
          pageId={pageId}
          showTitle={false}
        />
      )}
    </Container>
  );
}

type PageBylineProps = {
  creator?: PageUser;
  contributors?: IContributor[];
  readOnly?: boolean;
};

function PageByline({ creator, contributors, readOnly }: PageBylineProps) {
  const { t } = useTranslation();
  const detailsTriggerProps = useAsideTriggerProps("details");

  const otherContributors = (contributors ?? []).filter(
    (c) => c.id !== creator?.id,
  );

  return (
    <Group
      gap="sm"
      mb="md"
      className={clsx("print-hide", classes.byline)}
      style={{ marginTop: "-0.5em" }}
    >
      {creator && (
        <Popover position="bottom-start" shadow="md" width={280} withArrow>
          <Popover.Target>
            <UnstyledButton
              aria-label={t("Created by {{name}}", { name: creator.name })}
            >
              <Group gap={6}>
                <CustomAvatar
                  avatarUrl={creator.avatarUrl}
                  name={creator.name}
                  size={22}
                />
                <Text size="sm" c="dimmed">
                  {t("By {{name}}", { name: creator.name })}
                </Text>
              </Group>
            </UnstyledButton>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="xs">
              <Group gap="sm">
                <CustomAvatar
                  avatarUrl={creator.avatarUrl}
                  name={creator.name}
                  size={36}
                />
                <div>
                  <Text size="sm" fw={500}>
                    {creator.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {otherContributors.length === 0
                      ? t("Owner, no contributors")
                      : t("Owner")}
                  </Text>
                </div>
              </Group>

              {otherContributors.length > 0 && (
                <>
                  <Divider />
                  <Text size="xs" fw={500} c="dimmed" tt="uppercase">
                    {t("Contributors")}
                  </Text>
                  <Stack gap={6}>
                    {otherContributors.map((contributor) => (
                      <Group gap="sm" key={contributor.id}>
                        <CustomAvatar
                          avatarUrl={contributor.avatarUrl}
                          name={contributor.name}
                          size={28}
                        />
                        <Text size="sm">{contributor.name}</Text>
                      </Group>
                    ))}
                  </Stack>
                </>
              )}
            </Stack>
          </Popover.Dropdown>
        </Popover>
      )}
      <Tooltip label={t("Details")} withArrow openDelay={250}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t("Details")}
          {...detailsTriggerProps}
        >
          <IconInfoCircle size={20} stroke={1.5} />
        </ActionIcon>
      </Tooltip>

      <PageVerificationBadge readOnly={readOnly} />
    </Group>
  );
}
