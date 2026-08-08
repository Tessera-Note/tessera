import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  pageTitle: string;
  spaceName: string;
  pageUrl: string;
}

export const VerificationExpiredEmail = ({ pageTitle, spaceName, pageUrl }: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          A verificação de <strong>{pageTitle}</strong>, no espaço{' '}
          <strong>{spaceName}</strong>, expirou. Verifique a página de novo para
          confirmar que continua correta.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Verificar novamente</EmailButton>
    </MailBody>
  );
};

export default VerificationExpiredEmail;
