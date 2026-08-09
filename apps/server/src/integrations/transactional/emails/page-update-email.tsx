import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  userName: string;
  actorName: string;
  pageTitle: string;
  pageUrl: string;
  spaceName: string;
  locale?: string;
}

export const PageUpdateEmail = ({
  userName,
  actorName,
  pageTitle,
  pageUrl,
  spaceName,
  locale,
}: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting name={userName} locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.page_update.body', {
            actor: actorName,
            page: pageTitle,
            space: spaceName,
          })}
        </Text>
      </Section>
      <EmailButton href={pageUrl}>
        {mailText(locale, 'mail.action.open_page')}
      </EmailButton>
    </MailBody>
  );
};

export default PageUpdateEmail;
