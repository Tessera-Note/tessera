import { Section, Text } from 'react-email';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { EmailButton, Greeting, MailBody } from '../partials/partials';

interface Props {
  pageTitle: string;
  spaceName: string;
  pageUrl: string;
}

export const VerificationExpiredEmail = ({ pageTitle, spaceName, pageUrl }: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Greeting />
        <Text style={paragraph}>
          Verification of <strong>{pageTitle}</strong> in{' '}
          <strong>{spaceName}</strong> has expired. Verify the page again to
          confirm it is still correct.
        </Text>
      </Section>
      <EmailButton href={pageUrl}>Verify page</EmailButton>
    </MailBody>
  );
};

export default VerificationExpiredEmail;
