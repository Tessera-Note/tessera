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
          Recebemos um pedido para redefinir sua senha.
        </Text>
      </Section>
      <EmailButton href={resetLink}>Definir nova senha</EmailButton>
      <Section style={content}>
        <Text style={paragraphMuted}>
          O link vale por 30 minutos. Se não foi você que pediu, ignore este
          e-mail.
        </Text>
      </Section>
    </MailBody>
  );
};

export default ForgotPasswordEmail;
