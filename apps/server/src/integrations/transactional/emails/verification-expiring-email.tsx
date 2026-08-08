import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  pageTitle: string;
  spaceName: string;
  pageUrl: string;
  expiresAt: string;
}

export const VerificationExpiringEmail = ({
  pageTitle,
  spaceName,
  pageUrl,
  expiresAt,
}: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          A página <strong>{pageTitle}</strong>, no espaço{' '}
          <strong>{spaceName}</strong>, precisa ser verificada de novo. A
          verificação expira em <strong>{expiresAt}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Revisar página</EmailButton>
    </MailBody>
  );
};

export default VerificationExpiringEmail;
