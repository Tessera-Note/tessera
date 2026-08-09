import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { Group, Text, Paper, ActionIcon, Loader, Tooltip } from "@mantine/core";
import { getFileUrl } from "@/lib/config.ts";
import { IconDownload, IconFileTypePdf, IconPaperclip } from "@tabler/icons-react";
import { useHover } from "@mantine/hooks";
import { formatBytes } from "@/lib";
import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import { notifications } from "@mantine/notifications";
import { mediaErrorMessage } from "@tessera/editor-ext";
import { useMediaError } from "@/features/editor/hooks/use-media-error";

export default function AttachmentView(props: NodeViewProps) {
  const { t } = useTranslation();
  const { editor, node, getPos, selected } = props;
  const { url, name, size, mime, attachmentId, placeholder } = node.attrs;
  const { hovered, ref } = useHover();
  const mediaError = useMediaError();

  /**
   * Раньше ссылка вела прямо на файл, и при удаленном вложении в новой
   * вкладке открывался JSON с ошибкой сервера. Теперь статус проверяется
   * до перехода, и человек видит причину словами.
   */
  const handleDownload = useCallback(
    async (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!url) return;

      event.preventDefault();

      const fileUrl = getFileUrl(url);
      const status = await mediaError.report(fileUrl);

      if (status && status < 400) {
        mediaError.clear();
        window.open(fileUrl, "_blank", "noopener");
        return;
      }

      notifications.show({
        message: mediaErrorMessage(status),
        color: "red",
        position: "top-right",
      });
    },
    [url, mediaError],
  );

  const isPdf = mime === "application/pdf" || name?.toLowerCase().endsWith(".pdf");

  const handleEmbedAsPdf = useCallback(() => {
    const pos = getPos();
    if (pos === undefined || !url) return;

    const nodeSize = node.nodeSize;

    editor
      .chain()
      .insertContentAt(
        { from: pos, to: pos + nodeSize },
        {
          type: "pdf",
          attrs: {
            src: url,
            name,
            attachmentId,
            size,
          },
        },
      )
      .run();
  }, [editor, getPos, node, url, name, attachmentId]);

  return (
    <NodeViewWrapper>
      <Paper withBorder p="4px" ref={ref} data-drag-handle>
        <Group
          justify="space-between"
          gap="xl"
          style={{ cursor: "pointer" }}
          wrap="nowrap"
          h={25}
        >
          <Group wrap="nowrap" gap="sm" style={{ minWidth: 0, flex: 1 }}>
            {!url && placeholder ? (
              <Loader size={20} style={{ flexShrink: 0 }} />
            ) : (
              <IconPaperclip size={20} style={{ flexShrink: 0 }} />
            )}

            <Text component="span" size="md" truncate="end" style={{ minWidth: 0 }}>
              {!url && placeholder ? t("Uploading {{name}}", { name }) : name}
            </Text>

            <Text component="span" size="sm" c="dimmed" style={{ flexShrink: 0 }}>
              {formatBytes(size)}
            </Text>
          </Group>

          {url && (selected || hovered) && (
            <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
              {isPdf && editor.isEditable && (
                <Tooltip label={t("Embed as PDF")} position="top" withinPortal={false}>
                  <ActionIcon variant="default" aria-label={t("Embed as PDF")} onClick={handleEmbedAsPdf}>
                    <IconFileTypePdf size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
              <a href={getFileUrl(url)} target="_blank" onClick={handleDownload}>
                <ActionIcon variant="default" aria-label="download file">
                  <IconDownload size={18} />
                </ActionIcon>
              </a>
            </Group>
          )}
        </Group>
      </Paper>
    </NodeViewWrapper>
  );
}
