import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  actorName: string;
  pageTitle: string;
  pageUrl: string;
}

export const CommentResolvedEmail = ({
  actorName,
  pageTitle,
  pageUrl,
}: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          <strong>{actorName}</strong> resolveu um comentário em{' '}
          <strong>{pageTitle}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Ver página</EmailButton>
    </MailBody>
  );
};

export default CommentResolvedEmail;
