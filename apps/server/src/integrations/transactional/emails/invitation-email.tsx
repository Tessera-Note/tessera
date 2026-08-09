import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph, paragraphMuted } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  inviteLink: string;
}

export const InvitationEmail = ({ inviteLink }: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          You have been invited to Tessera, your team knowledge base.
        </Text>
      </Section>
      <EmailButton href={inviteLink}>Accept invitation</EmailButton>
      <Section style={content}>
        <Text style={paragraphMuted}>
          You received this email because someone on the team invited you.
        </Text>
      </Section>
    </MailBody>
  );
};

export default InvitationEmail;
