import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph, paragraphMuted } from '../css/styles';
import { Greeting, MailBody } from '../partials/partials';

interface Props {
  username?: string;
}

export const ChangePasswordEmail = ({ username }: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting name={username} />
        <Text style={paragraph}>Your password has been changed.</Text>
        <Text style={paragraphMuted}>
          If this was not you, contact a wiki administrator right away.
        </Text>
      </Section>
    </MailBody>
  );
};

export default ChangePasswordEmail;
