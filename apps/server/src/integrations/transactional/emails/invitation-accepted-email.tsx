import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { Greeting, MailBody } from '../partials/partials';

interface Props {
  invitedUserName: string;
  invitedUserEmail: string;
}

export const InvitationAcceptedEmail = ({
  invitedUserName,
  invitedUserEmail,
}: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          {invitedUserName} ({invitedUserEmail}) accepted your invitation and is
          now part of the workspace.
        </Text>
      </Section>
    </MailBody>
  );
};

export default InvitationAcceptedEmail;
