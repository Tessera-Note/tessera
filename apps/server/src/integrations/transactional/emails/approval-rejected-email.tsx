import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  actorName: string;
  pageTitle: string;
  spaceName: string;
  pageUrl: string;
  comment?: string;
  locale?: string;
}

export const ApprovalRejectedEmail = ({
  actorName,
  pageTitle,
  spaceName,
  pageUrl,
  comment,
  locale,
}: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.approval_rejected.body', {
            actor: actorName,
            page: pageTitle,
            space: spaceName,
          })}
        </Text>
        {comment && (
          <Text style={{ ...paragraph, fontStyle: 'italic' }}>
            &ldquo;{comment}&rdquo;
          </Text>
        )}
      </Section>
      <EmailButton href={pageUrl}>
        {mailText(locale, 'mail.action.open_page')}
      </EmailButton>
    </MailBody>
  );
};

export default ApprovalRejectedEmail;
