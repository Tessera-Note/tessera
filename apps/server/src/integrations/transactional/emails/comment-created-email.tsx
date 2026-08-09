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

export const CommentCreateEmail = ({
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
          {mailText(locale, 'mail.comment_created.body', {
            actor: actorName,
            page: pageTitle,
          })}
        </Text>
      </Section>
      <EmailButton href={pageUrl}>
        {mailText(locale, 'mail.action.view_comment')}
      </EmailButton>
    </MailBody>
  );
};

export default CommentCreateEmail;
