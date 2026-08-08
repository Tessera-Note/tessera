import { Group, List, Stack, Table, Text, ThemeIcon } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { getLicenseUrl, getSupportUrl } from "@/lib/config.ts";

const enterpriseFeatures = [
  "AI Integration (Chat, Search & Assistant)",
  "MCP Support",
  "SSO (SAML, OIDC, LDAP)",
  "SCIM Provisioning",
  "Multi-factor Authentication (2FA)",
  "Page-level Permissions",
  "Page Verification & Approval Workflow",
  "Audit Logs",
  "Enterprise Controls",
  "API Keys",
  "Advanced Search Engine Support",
  "Full-text Search in Attachments (PDF, DOCX)",
  "Resolve Comments",
  "Confluence Import",
  "PDF & DOCX Import",
  "Bases",
  "Kanban",
  "Templates",
  "Personal Spaces"
];

export default function OssDetails() {
  return (
    <Stack gap="lg">
      <Table.ScrollContainer minWidth={500} py="md">
        <Table
          variant="vertical"
          verticalSpacing="sm"
          layout="fixed"
          withTableBorder
        >
          <Table.Tbody>
            <Table.Tr>
              <Table.Th w={160}>Edition</Table.Th>
              <Table.Td>
                <Group wrap="nowrap">
                  Open Source
                  <div>
                    <ThemeIcon
                      color="green"
                      variant="light"
                      size={24}
                      radius="xl"
                    >
                      <IconCheck size={16} />
                    </ThemeIcon>
                  </div>
                </Group>
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Stack gap="md">
        <Text fw={500}>Upgrade to the Enterprise Edition to unlock:</Text>

        <List
          spacing={4}
          size="sm"
          icon={
            <ThemeIcon size={20} color={"gray"} radius="xl">
              <IconCheck size={14} />
            </ThemeIcon>
          }
        >
          {enterpriseFeatures.map((feature) => (
            <List.Item key={feature}>{feature}</List.Item>
          ))}
        </List>

        <Text size="sm" c="dimmed">
          This instance is operated in house. See the{" "}
          <a href={getLicenseUrl()} target="_blank" rel="noopener noreferrer">
            license page
          </a>{" "}
          for terms, and the{" "}
          <a href={getSupportUrl()} target="_blank" rel="noopener noreferrer">
            support page
          </a>{" "}
          for who to contact.
        </Text>
      </Stack>
    </Stack>
  );
}
