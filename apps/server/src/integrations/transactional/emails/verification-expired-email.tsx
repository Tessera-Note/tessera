import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  pageTitle: string;
  spaceName: string;
  pageUrl: string;
  locale?: string;
}

export const VerificationExpiredEmail = ({
  pageTitle,
  spaceName,
  pageUrl,
  locale,
}: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.verification_expired.body', {
            page: pageTitle,
            space: spaceName,
          })}
        </Text>
      </Section>
      <EmailButton href={pageUrl}>
        {mailText(locale, 'mail.action.verify_page')}
      </EmailButton>
    </MailBody>
  );
};

export default VerificationExpiredEmail;
