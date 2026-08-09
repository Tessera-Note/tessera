import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph, paragraphMuted } from '../css/styles';
import { Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  username?: string;
  workspaceName?: string;
  locale?: string;
}

/**
 * Уведомление о сбросе второго фактора администратором.
 *
 * Письмо обязательно: сброс делает другой человек, и владелец учетной записи
 * должен узнать об этом сам, а не обнаружить пропажу фактора при следующем
 * входе. Ссылок и кнопок в письме нет намеренно, чтобы его нельзя было
 * использовать как приманку.
 */
export const MfaResetEmail = ({ username, workspaceName, locale }: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting name={username} locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.mfa_reset.body', {
            scope: workspaceName ? ` (${workspaceName})` : '',
          })}
        </Text>
        <Text style={paragraph}>{mailText(locale, 'mail.mfa_reset.next')}</Text>
        <Text style={paragraphMuted}>
          {mailText(locale, 'mail.mfa_reset.warning')}
        </Text>
      </Section>
    </MailBody>
  );
};

export default MfaResetEmail;
