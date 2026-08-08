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
          Двоетапну перевірку для вашого облікового запису
          {workspaceName ? ` у просторі ${workspaceName}` : ''} скинув
          адміністратор. Другий фактор більше не потрібен для входу.
        </Text>
        <Text style={paragraph}>
          Налаштуйте двоетапну перевірку заново в налаштуваннях профілю.
        </Text>
        <Text style={paragraphMuted}>
          Якщо ви цього не просили, негайно зверніться до адміністратора.
        </Text>
      </Section>
    </MailBody>
  );
};

export default MfaResetEmail;
