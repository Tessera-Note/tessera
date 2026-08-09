import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph, paragraphMuted } from '../css/styles';
import { Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  username?: string;
  locale?: string;
}

export const ChangePasswordEmail = ({ username, locale }: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting name={username} locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.password_changed.body')}
        </Text>
        <Text style={paragraphMuted}>
          {mailText(locale, 'mail.password_changed.warning')}
        </Text>
      </Section>
    </MailBody>
  );
};

export default ChangePasswordEmail;
