import {
  Modal,
  Button,
  Group,
  Text,
  Select,
  Switch,
  Divider,
  Tooltip,
  Badge,
} from "@mantine/core";
import {
  exportPage,
  exportPageToDocx,
} from "@/features/page/services/page-service.ts";
import { useState } from "react";
import { ExportFormat } from "@/features/page/types/page.types.ts";
import { notifications } from "@mantine/notifications";
import { exportSpace } from "@/features/space/services/space-service";
import { exportPageToPdf } from "@/ee/pdf-export/services/pdf-export-service.ts";
import { useTranslation } from "react-i18next";
import { Feature } from "@/ee/features";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { useUpgradeLabel } from "@/ee/hooks/use-upgrade-label";

interface ExportModalProps {
  id: string;
  type: "space" | "page";
  open: boolean;
  onClose: () => void;
}

export default function ExportModal({
  id,
  type,
  open,
  onClose,
}: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>(ExportFormat.Markdown);
  const [includeChildren, setIncludeChildren] = useState<boolean>(false);
  const [includeAttachments, setIncludeAttachments] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const { t } = useTranslation();
  const upgradeLabel = useUpgradeLabel();
  const isDocx = format === ExportFormat.Docx;
  const isPdf = format === ExportFormat.Pdf;
  const docxEntitled = useHasFeature(Feature.DOCX_EXPORT);
  const blockedByLicense = isDocx && !docxEntitled;

  const handleExport = async () => {
    setIsExporting(true);
    try {
      if (type === "page") {
        if (format === ExportFormat.Docx) {
          await exportPageToDocx({ pageId: id });
        } else if (format === ExportFormat.Pdf) {
          // Rendered by a headless browser on the server, so this waits on a
          // background task instead of streaming straight back.
          notifications.show({
            message: t("Generating the PDF. This can take a few seconds."),
          });
          await exportPageToPdf({ pageId: id, includeChildren });
        } else {
          await exportPage({
            pageId: id,
            format,
            includeChildren,
            includeAttachments,
          });
        }
      }
      if (type === "space") {
        await exportSpace({ spaceId: id, format, includeAttachments });
      }
      notifications.show({
        message: t("Export successful"),
      });
      onClose();
    } catch (err) {
      notifications.show({
        message:
          "Export failed: " +
          (err?.response?.data?.message ?? err?.message ?? ""),
        color: "red",
      });
      console.error("export error", err);
    } finally {
      setIsExporting(false);
    }
  };

  const handleChange = (format: ExportFormat) => {
    setFormat(format);
  };

  return (
    <Modal.Root
      opened={open}
      onClose={onClose}
      size={500}
      padding="xl"
      yOffset="10vh"
      xOffset={0}
      mah={400}
      onClick={(e) => e.stopPropagation()}
    >
      <Modal.Overlay />
      <Modal.Content style={{ overflow: "hidden" }}>
        <Modal.Header py={0}>
          <Modal.Title fw={500}>{t(`Export ${type}`)}</Modal.Title>
          <Modal.CloseButton aria-label={t("Close")} />
        </Modal.Header>
        <Modal.Body>
          <Group justify="space-between" wrap="nowrap">
            <div>
              <Text size="md">{t("Format")}</Text>
            </div>
            <ExportFormatSelection
              format={format}
              onChange={handleChange}
              includeDocx={type === "page"}
              docxEntitled={docxEntitled}
            />
          </Group>

          {type === "page" && !isDocx && (
            <>
              <Divider my="sm" />

              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Text size="md">{t("Include subpages")}</Text>
                  {isPdf && (
                    <Text size="xs" c="dimmed">
                      {t("Each subpage starts on a new page.")}
                    </Text>
                  )}
                </div>
                <Switch
                  onChange={(event) =>
                    setIncludeChildren(event.currentTarget.checked)
                  }
                  checked={includeChildren}
                />
              </Group>

              {/* A PDF embeds its images already; there is no folder to put
                  attachments in. */}
              {!isPdf && (
                <Group justify="space-between" wrap="nowrap" mt="md">
                  <div>
                    <Text size="md">{t("Include attachments")}</Text>
                  </div>
                  <Switch
                    onChange={(event) =>
                      setIncludeAttachments(event.currentTarget.checked)
                    }
                    checked={includeAttachments}
                  />
                </Group>
              )}
            </>
          )}

          {type === "space" && (
            <>
              <Divider my="sm" />

              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Text size="md">{t("Include attachments")}</Text>
                </div>
                <Switch
                  onChange={(event) =>
                    setIncludeAttachments(event.currentTarget.checked)
                  }
                  checked={includeAttachments}
                />
              </Group>
            </>
          )}

          <Group justify="center" mt="md">
            <Button onClick={onClose} variant="default">
              {t("Cancel")}
            </Button>
            <Tooltip label={upgradeLabel} disabled={!blockedByLicense} withArrow>
              <Button
                onClick={handleExport}
                loading={isExporting}
                disabled={blockedByLicense}
                data-disabled={blockedByLicense || undefined}
              >
                {t("Export")}
              </Button>
            </Tooltip>
          </Group>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

interface ExportFormatSelection {
  format: ExportFormat;
  onChange: (value: string) => void;
  includeDocx?: boolean;
  docxEntitled?: boolean;
}
function ExportFormatSelection({
  format,
  onChange,
  includeDocx,
  docxEntitled,
}: ExportFormatSelection) {
  const { t } = useTranslation();

  const data = [
    { value: "markdown", label: "Markdown" },
    { value: "html", label: "HTML" },
    // PDF is rendered from the page itself, which only makes sense per page.
    ...(includeDocx
      ? [
          { value: "pdf", label: "PDF" },
          { value: "docx", label: "Word (.docx)", disabled: !docxEntitled },
        ]
      : []),
  ];

  return (
    <Select
      data={data}
      defaultValue={format}
      onChange={onChange}
      styles={{ wrapper: { maxWidth: 140 }, option: { opacity: 1 } }}
      comboboxProps={{ width: 200 }}
      allowDeselect={false}
      withCheckIcon={false}
      aria-label={t("Select export format")}
      renderOption={({ option }) =>
        option.value === "docx" && !docxEntitled ? (
          <div>
            <Text size="sm" c="dimmed">
              {option.label}
            </Text>
            <Badge size="xs" mt={4}>
              {t("Enterprise")}
            </Badge>
          </div>
        ) : (
          <Text size="sm">{option.label}</Text>
        )
      }
    />
  );
}
