import { Link, Section, Text } from 'react-email';
import * as React from 'react';
import { brand, content, link, paragraph } from '../css/styles';
import { Greeting, MailBody } from '../partials/partials';
import { mailText } from '../mail-text';

interface PageUpdate {
  title: string;
  url: string;
  updatedBy: string[];
}

interface Props {
  userName: string;
  pageUpdates: PageUpdate[];
  totalUpdates: number;
  locale?: string;
}

export const PageUpdateDigestEmail = ({
  userName,
  pageUpdates,
  totalUpdates,
  locale,
}: Props) => {
  return (
    <MailBody locale={locale}>
      <Section style={content}>
        <Greeting name={userName} locale={locale} />
        <Text style={paragraph}>
          {mailText(locale, 'mail.digest.body', { count: totalUpdates })}
        </Text>

        {pageUpdates.map((page, i) => (
          <Section key={i} style={pageCard}>
            <Text style={pageTitle}>
              <Link href={page.url} style={link}>
                {page.title}
              </Link>
            </Text>
            {page.updatedBy.length > 0 && (
              <Text style={updatedByText}>
                {mailText(locale, 'mail.digest.edited_by', {
                  names: page.updatedBy.join(', '),
                })}
              </Text>
            )}
          </Section>
        ))}
      </Section>
    </MailBody>
  );
};

const pageCard = {
  borderLeft: `3px solid ${brand.yellow}`,
  paddingLeft: '12px',
  marginBottom: '12px',
};

const pageTitle = {
  ...paragraph,
  margin: '0 0 2px 0',
  fontSize: 14,
  fontWeight: 500,
};

const updatedByText = {
  ...paragraph,
  margin: '0',
  fontSize: 13,
  color: brand.greyText,
};

export default PageUpdateDigestEmail;
