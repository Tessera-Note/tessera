import { BadRequestException } from '@nestjs/common';
import { Workspace } from '@tessera/db/types/entity.types';
import { createHmac } from 'node:crypto';
import { ErrorMessage, badRequest } from '../../common/errors/app-error';

export function computeEmailSignature(
  email: string,
  workspaceId: string,
  appSecret: string,
): string {
  return createHmac('sha256', appSecret)
    .update(`${email.toLowerCase()}:${workspaceId}`)
    .digest('hex');
}

export function throwIfEmailNotVerified(opts: {
  isCloud: boolean;
  emailVerifiedAt: Date | null;
  email: string;
  workspaceId: string;
  appSecret: string;
}): void {
  if (!opts.isCloud || opts.emailVerifiedAt) return;

  const emailSignature = computeEmailSignature(
    opts.email,
    opts.workspaceId,
    opts.appSecret,
  );
  // Клиент по этому отказу уводит на страницу подтверждения, и раньше он
  // узнавал его сравнением английского текста сообщения. Перевод сообщения
  // сломал бы переход молча, поэтому опознается код.
  throw new BadRequestException({
    message: ErrorMessage['error.auth.email_not_verified'],
    code: 'error.auth.email_not_verified',
    emailSignature,
  });
}

export function validateSsoEnforcement(workspace: Workspace) {
  if (workspace.enforceSso) {
    throw badRequest('error.auth.this_workspace_has_enforced_sso_login');
  }
}

export function validateAllowedEmail(userEmail: string, workspace: Workspace) {
  const emailParts = userEmail.split('@');
  const emailDomain = emailParts[1].toLowerCase();
  if (
    workspace.emailDomains?.length > 0 &&
    !workspace.emailDomains.includes(emailDomain)
  ) {
    throw badRequest('error.auth.email_domain_not_approved', {
      domain: emailDomain,
    });
  }
}
