import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface Props {
  actorName: string;
  pageTitle: string;
  pageUrl: string;
  locale?: string;
}

export const PageMentionEmail = ({
  actorName,
  pageTitle,
  pageUrl,
  locale,
}: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.page_mention.body', {
            actor: actorName,
            page: pageTitle,
          })}
        </Text>
      </Section>
      <EmailButton href={pageUrl}>
        {mailText(locale, 'mail.action.open_page')}
      </EmailButton>
    </MailBody>
  );
};

export default PageMentionEmail;
