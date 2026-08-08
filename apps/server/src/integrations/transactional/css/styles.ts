// Tessera brand values: the yellow is the
// "Quero contratar" CTA fill, the pill radius is that button's, and the grey
// is the site header. Black on yellow is not a style choice — white on
// #FFD31C lands around 1.5:1 contrast and is unreadable.
export const brand = {
  yellow: '#FFD31C',
  black: '#141414',
  greyBg: '#F4F4F4',
  greyText: '#5F5E5A',
  border: '#E6E6E6',
};

// Mail clients rarely load webfonts, so Montserrat is declared for the few
// that do (mostly Apple Mail) and the stack degrades everywhere else.
export const fontFamily =
  "Montserrat, 'Helvetica Neue', Helvetica, Arial, sans-serif";

export const main = {
  backgroundColor: brand.greyBg,
  fontFamily,
};

export const container = {
  maxWidth: '580px',
  margin: '10px auto',
  backgroundColor: '#ffffff',
  borderColor: brand.border,
  borderRadius: '12px',
  borderWidth: '1px',
  borderStyle: 'solid',
  padding: '4px 0',
};

export const content = {
  padding: '8px 24px 16px 24px',
};

export const paragraph = {
  fontFamily,
  color: brand.black,
  lineHeight: 1.6,
  fontSize: 14,
  margin: '0 0 10px 0',
};

export const paragraphMuted = {
  ...paragraph,
  color: brand.greyText,
};

export const h1 = {
  fontFamily,
  color: brand.black,
  fontSize: '20px',
  fontWeight: 500,
  padding: '0',
};

export const logo = {
  textAlign: 'center' as const,
  padding: '14px 0 6px 0',
};

export const link = {
  color: brand.black,
  textDecoration: 'underline',
};

export const footer = {
  maxWidth: '580px',
  margin: '0 auto',
};

export const button = {
  backgroundColor: brand.yellow,
  borderRadius: '100px',
  color: brand.black,
  fontFamily,
  fontSize: '14px',
  fontWeight: 500,
  textDecoration: 'none',
  textAlign: 'center' as const,
  padding: '11px 22px',
};
