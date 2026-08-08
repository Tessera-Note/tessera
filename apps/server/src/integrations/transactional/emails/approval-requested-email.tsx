import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  actorName: string;
  pageTitle: string;
  spaceName: string;
  pageUrl: string;
}

export const ApprovalRequestedEmail = ({
  actorName,
  pageTitle,
  spaceName,
  pageUrl,
}: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          <strong>{actorName}</strong> enviou <strong>{pageTitle}</strong>, no
          espaço <strong>{spaceName}</strong>, para sua aprovação.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Revisar página</EmailButton>
    </MailBody>
  );
};

export default ApprovalRequestedEmail;
