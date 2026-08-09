import {
  brand,
  button as buttonStyle,
  container,
  fontFamily,
  footer,
  logo,
  main,
  paragraph,
} from '../css/styles';
import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Row,
  Section,
  Text,
} from 'react-email';
import * as React from 'react';
import { mailText } from '../mail-text';

interface MailBodyProps {
  locale?: string;
  children: React.ReactNode;
}

export function MailBody({ children, locale }: MailBodyProps) {
  return (
    <Html>
      <Head />
      <Body style={main}>
        <MailHeader />
        <Container style={container}>{children}</Container>
        <MailFooter locale={locale} />
      </Body>
    </Html>
  );
}

export function MailHeader() {
  return (
    <Section style={logo}>
      {/* Logo and wordmark together on purpose: most clients block images on
          the first mail from an unknown sender, which is exactly the invite
          case, and the header would otherwise render empty. */}
      <Img
        src={`${(process.env.APP_URL || '').replace(/\/$/, '')}/tessera-wiki-logo.png`}
        alt="Tessera"
        width="104"
        height="36"
        style={{ display: 'block', margin: '0 auto 6px auto' }}
      />
      <Text
        style={{
          fontFamily,
          fontSize: '13px',
          fontWeight: 500,
          color: brand.black,
          margin: 0,
          textAlign: 'center' as const,
        }}
      >
        Tessera
      </Text>
    </Section>
  );
}

interface EmailButtonProps {
  href: string;
  children: React.ReactNode;
}

export function EmailButton({ href, children }: EmailButtonProps) {
  return (
    <table
      role="presentation"
      cellPadding="0"
      cellSpacing="0"
      style={{ margin: '4px 0 8px 24px' }}
    >
      <tr>
        <td
          style={{
            backgroundColor: buttonStyle.backgroundColor,
            borderRadius: buttonStyle.borderRadius,
            textAlign: 'center' as const,
          }}
        >
          <a
            href={href}
            target="_blank"
            style={{
              color: buttonStyle.color,
              fontFamily: buttonStyle.fontFamily,
              fontSize: buttonStyle.fontSize,
              fontWeight: buttonStyle.fontWeight,
              textDecoration: 'none',
              display: 'inline-block',
              padding: buttonStyle.padding,
            }}
          >
            {children}
          </a>
        </td>
      </tr>
    </table>
  );
}

export function MailFooter({ locale }: { locale?: string }) {
  return (
    <Section style={footer}>
      <Row>
        <Text
          style={{
            fontFamily,
            textAlign: 'center' as const,
            color: brand.greyText,
            fontSize: '12px',
          }}
        >
          {mailText(locale, 'mail.footer')}
        </Text>
      </Row>
    </Section>
  );
}

export function Greeting({ name, locale }: { name?: string; locale?: string }) {
  const first = name?.trim().split(' ')[0];
  return (
    <Text style={paragraph}>
      {first
        ? mailText(locale, 'mail.greeting_named', { name: first })
        : mailText(locale, 'mail.greeting')}
    </Text>
  );
}
