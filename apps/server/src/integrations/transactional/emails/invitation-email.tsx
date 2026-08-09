import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph, paragraphMuted } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  inviteLink: string;
  locale?: string;
}

export const InvitationEmail = ({ inviteLink, locale }: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.invitation.body')}
        </Text>
      </Section>
      <EmailButton href={inviteLink}>
        {mailText(locale, 'mail.action.accept_invitation')}
      </EmailButton>
      <Section style={content}>
        <Text style={paragraphMuted}>
          {mailText(locale, 'mail.invitation.note')}
        </Text>
      </Section>
    </MailBody>
  );
};

export default InvitationEmail;
