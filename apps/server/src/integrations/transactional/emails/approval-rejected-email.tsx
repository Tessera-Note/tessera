import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  actorName: string;
  pageTitle: string;
  spaceName: string;
  pageUrl: string;
  comment?: string;
}

export const ApprovalRejectedEmail = ({
  actorName,
  pageTitle,
  spaceName,
  pageUrl,
  comment,
}: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          <strong>{actorName}</strong> devolveu <strong>{pageTitle}</strong>, no
          espaço <strong>{spaceName}</strong>, para revisão.
        </Text>
        {comment && (
          <Text style={{ ...paragraph, fontStyle: 'italic' }}>
            &ldquo;{comment}&rdquo;
          </Text>
        )}
      </Section>
      <EmailButton href={pageUrl}>Ver página</EmailButton>
    </MailBody>
  );
};

export default ApprovalRejectedEmail;
