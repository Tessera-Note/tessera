import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  actorName: string;
  pageTitle: string;
  pageUrl: string;
  accessLabel: string;
  locale?: string;
}

export const PermissionGrantedEmail = ({
  actorName,
  pageTitle,
  pageUrl,
  accessLabel,
  locale,
}: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.permission_granted.body', {
            actor: actorName,
            page: pageTitle,
            access: accessLabel,
          })}
        </Text>
      </Section>
      <EmailButton href={pageUrl}>
        {mailText(locale, 'mail.action.open_page')}
      </EmailButton>
    </MailBody>
  );
};

export default PermissionGrantedEmail;
