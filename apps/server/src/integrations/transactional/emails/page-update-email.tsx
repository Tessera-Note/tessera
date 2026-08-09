import { Link, Section, Text } from 'react-email';
import * as React from 'react';
import { content, link, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  userName: string;
  actorName: string;
  pageTitle: string;
  pageUrl: string;
  spaceName: string;
}

export const PageUpdateEmail = ({
  userName,
  actorName,
  pageTitle,
  pageUrl,
  spaceName,
}: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting name={userName} />
        <Text style={paragraph}>
          <strong>{actorName}</strong> updated{' '}
          <Link href={pageUrl} style={link}>
            <strong>{pageTitle}</strong>
          </Link>{' '}
          in <strong>{spaceName}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Open page</EmailButton>
    </MailBody>
  );
};

export default PageUpdateEmail;
