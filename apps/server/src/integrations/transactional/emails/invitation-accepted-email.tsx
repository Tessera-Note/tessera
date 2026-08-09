import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  invitedUserName: string;
  invitedUserEmail: string;
  locale?: string;
}

export const InvitationAcceptedEmail = ({
  invitedUserName,
  invitedUserEmail,
  locale,
}: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.invitation_accepted.body', {
            name: invitedUserName,
            email: invitedUserEmail,
          })}
        </Text>
      </Section>
    </MailBody>
  );
};

export default InvitationAcceptedEmail;
