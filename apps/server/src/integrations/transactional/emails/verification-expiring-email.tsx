import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  pageTitle: string;
  spaceName: string;
  pageUrl: string;
  expiresAt: string;
  locale?: string;
}

export const VerificationExpiringEmail = ({
  pageTitle,
  spaceName,
  pageUrl,
  expiresAt,
  locale,
}: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.verification_expiring.body', {
            page: pageTitle,
            space: spaceName,
            date: expiresAt,
          })}
        </Text>
      </Section>
      <EmailButton href={pageUrl}>
        {mailText(locale, 'mail.action.verify_page')}
      </EmailButton>
    </MailBody>
  );
};

export default VerificationExpiringEmail;
