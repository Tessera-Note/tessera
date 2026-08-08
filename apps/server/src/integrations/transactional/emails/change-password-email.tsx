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
        <Text style={paragraph}>Sua senha foi alterada.</Text>
        <Text style={paragraphMuted}>
          Se não foi você, procure um administrador da wiki agora.
        </Text>
      </Section>
    </MailBody>
  );
};

export default ChangePasswordEmail;
