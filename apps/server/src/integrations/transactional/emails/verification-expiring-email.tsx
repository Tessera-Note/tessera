import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  pageTitle: string;
  spaceName: string;
  pageUrl: string;
  expiresAt: string;
}

export const VerificationExpiringEmail = ({
  pageTitle,
  spaceName,
  pageUrl,
  expiresAt,
}: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          The page <strong>{pageTitle}</strong> in{' '}
          <strong>{spaceName}</strong> needs to be verified again. Verification
          expires on <strong>{expiresAt}</strong>.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Verify page</EmailButton>
    </MailBody>
  );
};

export default VerificationExpiringEmail;
