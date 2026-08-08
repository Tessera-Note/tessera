import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  actorName: string;
  pageTitle: string;
  pageUrl: string;
  accessLabel: string;
}

export const PermissionGrantedEmail = ({
  actorName,
  pageTitle,
  pageUrl,
  accessLabel,
}: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          <strong>{actorName}</strong> deu acesso de {accessLabel} a{' '}
          <strong>{pageTitle}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Ver página</EmailButton>
    </MailBody>
  );
};

export default PermissionGrantedEmail;
