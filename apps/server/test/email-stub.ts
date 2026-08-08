/**
 * Transactional email templates are React components (.tsx) importing
 * react-email, which is ESM-only and pulls a large ESM dependency tree that
 * jest cannot parse without transforming all of it.
 *
 * Specs that touch a service only to read Nest module metadata should not drag
 * a React renderer into the worker, so jest maps every template here. Nothing
 * under test renders one; if a spec ever needs the real template, give it an
 * explicit jest.mock instead of removing this mapping.
 */
const EmailStub = () => null;

export default EmailStub;
