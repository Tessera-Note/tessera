import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph, paragraphMuted } from '../css/styles';
import { Greeting, MailBody } from '../partials/partials';

interface Props {
  username?: string;
  workspaceName?: string;
}

/**
 * Уведомление о сбросе второго фактора администратором.
 *
 * Письмо обязательно: сброс делает другой человек, и владелец учетной записи
 * должен узнать об этом сам, а не обнаружить пропажу фактора при следующем
 * входе. Ссылок и кнопок в письме нет намеренно, чтобы его нельзя было
 * использовать как приманку.
 */
export const MfaResetEmail = ({ username, workspaceName }: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting name={username} />
        <Text style={paragraph}>
          An administrator reset two-factor authentication for your account
          {workspaceName ? ` in ${workspaceName}` : ''}. A second factor is no
          longer required to sign in.
        </Text>
        <Text style={paragraph}>
          Set two-factor authentication up again in your profile settings.
        </Text>
        <Text style={paragraphMuted}>
          If you did not ask for this, contact an administrator right away.
        </Text>
      </Section>
    </MailBody>
  );
};

export default MfaResetEmail;
