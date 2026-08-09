import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph, paragraphMuted } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  username: string;
  resetLink: string;
}

export const ForgotPasswordEmail = ({ username, resetLink }: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting name={username} />
        <Text style={paragraph}>
          We received a request to reset your password.
        </Text>
      </Section>
      <EmailButton href={resetLink}>Set a new password</EmailButton>
      <Section style={content}>
        <Text style={paragraphMuted}>
          The link is valid for 30 minutes. If you did not request it, ignore
          this email.
        </Text>
      </Section>
    </MailBody>
  );
};

export default ForgotPasswordEmail;
