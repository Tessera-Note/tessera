import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph, paragraphMuted } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  username: string;
  resetLink: string;
  locale?: string;
}

export const ForgotPasswordEmail = ({ username, resetLink, locale }: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting name={username} locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.forgot_password.body')}
        </Text>
      </Section>
      <EmailButton href={resetLink}>
        {mailText(locale, 'mail.action.set_password')}
      </EmailButton>
      <Section style={content}>
        <Text style={paragraphMuted}>
          {mailText(locale, 'mail.forgot_password.note')}
        </Text>
      </Section>
    </MailBody>
  );
};

export default ForgotPasswordEmail;
