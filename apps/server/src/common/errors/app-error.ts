import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Отказ с машиночитаемым кодом.
 *
 * Сообщения об отказах приходили с сервера готовым текстом на русском, а
 * клиент показывает именно их, предпочитая локализованному запасному
 * варианту. В итоге человек с любой из двенадцати локалей видел русскую
 * строку, а заведенный рядом ключ перевода не отображался почти никогда.
 *
 * Наружу теперь уходит код. Клиент переводит по коду, а человекочитаемый
 * текст остается для журнала и внешних потребителей API: правка формулировки
 * больше не ломает перевод, а перевод не зависит от языка серверного кода.
 *
 * Код одновременно служит ключом перевода. Второй таблицы соответствий не
 * заводится намеренно: она неизбежно разошлась бы с кодами, и разойтись могла
 * бы молча.
 */

/** Подстановки в текст отказа. Уходят наружу вместе с кодом. */
export type ErrorParams = Record<string, string | number>;

/**
 * Коды отказов и английский текст к ним.
 *
 * Текст здесь запасной: он попадает в журнал и в ответ для тех, кто читает
 * API напрямую. Человеку в интерфейсе показывается перевод по коду.
 */
export const ErrorMessage = {
  'error.audit.retention_invalid':
    'Audit retention must be a whole number of days, zero or more',
  'error.base.csv_row_limit': 'CSV export is limited to {{limit}} rows',
  'error.import.docx_empty': 'The document file is empty',
  'error.import.docx_unreadable': 'The Word document could not be parsed',
  'error.import.pdf_empty': 'The PDF file is empty',
  'error.import.pdf_unreadable': 'The PDF file could not be parsed',
  'error.import.pdf_no_text_layer':
    'This PDF has no text layer: it is a scan or an image-only document',
  'error.workspace.not_found': 'Workspace not found',
  'error.auth.email_not_verified':
    'Please verify your email address. Check your inbox for the verification link.',
  'error.mcp.cells_required': 'The cells argument is required',
  'error.mcp.argument_must_be_object':
    'The {{argument}} argument must be an object of the form { "key": value }',

  'error.mfa.session_expired': 'The confirmation session has expired',
  'error.mfa.code_invalid': 'The code is not correct',
  'error.mfa.user_not_found': 'User not found',
  'error.mfa.not_enabled_for_user':
    'Two-factor authentication is not enabled for this user',
  'error.mfa.not_enabled': 'Two-factor authentication is not enabled',
  'error.mfa.already_enabled': 'Two-factor authentication is already enabled',
  'error.mfa.setup_not_started': 'Two-factor setup has not been started',
  'error.mfa.password_invalid': 'The password is not correct',

  'error.scim.token_limit':
    'The limit of {{limit}} active tokens is reached. Revoke the ones you no longer need',
  'error.scim.token_not_found': 'SCIM token not found',

  'error.sso.google_not_configured':
    'Google sign-in is not configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set',
  'error.sso.google_unavailable': 'Google is not responding',
  'error.sso.login_session_expired':
    'The sign-in session was not found or has expired',
  'error.sso.not_confirmed': 'Sign-in through the provider was not confirmed',
  'error.sso.no_subject': 'The provider did not return an identifier',
  'error.sso.email_not_verified': 'The email address is not verified',
  'error.sso.no_email': 'The provider did not return an email address',
  'error.sso.no_response': 'The provider did not return a response',
  'error.sso.directory_unavailable':
    'The user directory is unavailable. Contact your administrator',
  'error.sso.directory_no_stable_id':
    'The directory does not provide a stable user identifier. Contact your administrator',
  'error.sso.directory_no_email': 'This directory account has no email address',
  'error.sso.directory_ambiguous':
    'The directory configuration is ambiguous. Contact your administrator',
  'error.sso.credentials_invalid': 'Wrong username or password',
  'error.sso.client_secret_missing':
    'The provider has no client secret configured',
  'error.sso.issuer_invalid': 'The issuer address is not valid',
  'error.sso.issuer_not_https': 'The issuer address must start with https',
  'error.sso.provider_unreachable':
    'The sign-in provider is not responding or is misconfigured',
  'error.sso.provider_unavailable': 'The sign-in provider is unavailable',
  'error.sso.provider_ambiguous':
    'The sign-in provider configuration is ambiguous',
  'error.sso.account_unavailable': 'The account is unavailable',
  'error.sso.identity_conflict':
    'An account with this email is already linked to the provider under a different identifier. Contact your administrator',
  'error.sso.signup_disabled':
    'This provider does not create new accounts. Contact your administrator',
  'error.sso.provider_not_found': 'Sign-in provider not found',
  'error.sso.ldaps_starttls_conflict':
    'An ldaps address already encrypts the connection, enabling StartTLS separately is not allowed',
  'error.sso.filter_invalid':
    'The search filter is not written correctly and cannot be parsed',
  'error.sso.provider_type_unknown': 'Unknown sign-in provider type',
  'error.sso.provider_fields_required':
    'Provider type {{type}} requires: {{fields}}',
  'error.sso.user_not_found': 'User not found',
  'error.sso.user_has_no_links': 'This user has no sign-in provider links',

  // Отказы core. Переведены на коды пакетом: сообщение было готовым
  // английским текстом, и человек с русской или украинской локалью читал его
  // по-английски.
  'error.api_key.expiresat_must_be_in_the_future':
    'expiresAt must be in the future',
  'error.api_key.api_access_is_restricted_to_workspace':
    'API access is restricted to workspace administrators',
  'error.attachment.failed_to_upload_file': 'Failed to upload file',
  'error.attachment.pageid_is_required': 'PageId is required',
  'error.common.page_not_found': 'Page not found',
  'error.attachment.invalid_attachment_id': 'Invalid attachment id',
  'error.attachment.error_processing_file_upload':
    'Error processing file upload.',
  'error.attachment.invalid_file_id': 'Invalid file id',
  'error.attachment.file_not_found': 'File not found',
  'error.attachment.expired_or_invalid_attachment_access_token':
    'Expired or invalid attachment access token',
  'error.attachment.invalid_file_upload': 'Invalid file upload',
  'error.attachment.attachment_type_is_required': 'attachment type is required',
  'error.attachment.invalid_image_attachment_type':
    'Invalid image attachment type',
  'error.common.spaceid_is_required': 'spaceId is required',
  'error.attachment.invalid_file_name': 'Invalid file name',
  'error.attachment.spaceid_is_required_to_change_space':
    'spaceId is required to change space icons',
  'error.attachment.existing_attachment_to_overwrite_not_found':
    'Existing attachment to overwrite not found',
  'error.attachment.file_attachment_does_not_match':
    'File attachment does not match',
  'error.attachment.image_upload_aborted': 'Image upload aborted.',
  'error.attachment.failed_to_upload_image': 'Failed to upload image',
  'error.attachment.error_uploading_file_to_drive':
    'Error uploading file to drive',
  'error.common.space_not_found': 'Space not found',
  'error.auth.this_workspace_has_enforced_sso_login':
    'This workspace has enforced SSO login.',
  'error.auth.workspace_setup_already_completed':
    'Workspace setup already completed.',
  'error.common.user_not_found': 'User not found',
  'error.auth.current_password_is_incorrect': 'Current password is incorrect',
  'error.auth.invalid_or_expired_token': 'Invalid or expired token',
  'error.auth.an_account_with_this_email_already':
    'An account with this email already exists in this workspace',
  'error.auth.invalid_jwt_token_token_type_does':
    'Invalid JWT token. Token type does not match.',
  'error.auth.workspace_does_not_match': 'Workspace does not match',
  'error.casl.space_permissions_not_found': 'Space permissions not found',
  'error.casl.workspace_permissions_not_found':
    'Workspace permissions not found',
  'error.comment.comment_not_found': 'Comment not found',
  'error.comment.you_can_only_delete_your_own':
    'You can only delete your own comments',
  'error.comment.parent_comment_not_found': 'Parent comment not found',
  'error.comment.you_cannot_reply_to_a_reply': 'You cannot reply to a reply',
  'error.comment.you_can_only_edit_your_own':
    'You can only edit your own comments',
  'error.favorite.pageid_is_required': 'pageId is required',
  'error.favorite.templateid_is_required': 'templateId is required',
  'error.favorite.template_not_found': 'Template not found',
  'error.favorite.invalid_favorite_type': 'Invalid favorite type',
  'error.group.you_cannot_remove_users_from_a':
    'You cannot remove users from a default group',
  'error.group.group_member_not_found': 'Group member not found',
  'error.common.space_admin_required':
    'There must be at least one space admin with full access',
  'error.group.group_not_found': 'Group not found',
  'error.group.group_name_already_exists': 'Group name already exists',
  'error.group.you_cannot_update_a_default_group':
    'You cannot update a default group',
  'error.group.you_cannot_delete_a_default_group':
    'You cannot delete a default group',
  'error.label.labelid_or_name_is_required': 'labelId or name is required',
  'error.label.label_not_found': 'Label not found',
  'error.page.parent_page_not_found': 'Parent page not found',
  'error.page.only_space_admins_can_permanently_delete':
    'Only space admins can permanently delete pages',
  'error.page.page_history_not_found': 'Page history not found',
  'error.page.either_spaceid_or_pageid_must_be':
    'Either spaceId or pageId must be provided',
  'error.page.page_to_move_not_found': 'Page to move not found',
  'error.page.page_is_already_in_this_space': 'Page is already in this space',
  'error.page.page_to_copy_not_found': 'Page to copy not found',
  'error.page.moved_page_not_found': 'Moved page not found',
  'error.page.target_parent_page_not_found': 'Target parent page not found',
  'error.page.invalid_move_position': 'Invalid move position',
  'error.page.invalid_content_format': 'Invalid content format',
  'error.page.reference_page_not_found': 'Reference page not found',
  'error.page.source_page_not_found': 'Source page not found',
  'error.page.sync_block_not_found': 'Sync block not found',
  'error.search.shareid_is_required': 'shareId is required',
  'error.session.cannot_revoke_current_session_use_logout':
    'Cannot revoke current session. Use logout instead.',
  'error.session.current_session_not_found_please_log':
    'Current session not found. Please log in again.',
  'error.share.shared_page_not_found': 'Shared page not found',
  'error.share.share_not_found': 'Share not found',
  'error.share.cannot_share_a_restricted_page':
    'Cannot share a restricted page',
  'error.share.public_sharing_is_disabled': 'Public sharing is disabled',
  'error.share.failed_to_share_page': 'Failed to share page',
  'error.share.failed_to_update_share': 'Failed to update share',
  'error.common.this_feature_requires_a_valid_license':
    'This feature requires a valid license',
  'error.space.personal_spaces_are_not_enabled_for':
    'Personal spaces are not enabled for this workspace',
  'error.space.you_already_have_a_personal_space':
    'You already have a personal space',
  'error.space.user_already_added_to_this_space':
    'User already added to this space',
  'error.space.please_provide_a_valid_userid_or':
    'Please provide a valid userId or groupId to remove',
  'error.space.space_membership_not_found': 'Space membership not found',
  'error.space.space_slug_exists_please_use_a':
    'Space slug exists. Please use a unique space slug',
  'error.space.userids_or_groupids_is_required':
    'userIds or groupIds is required',
  'error.space.userid_or_groupid_is_required': 'userId or groupId is required',
  'error.space.please_provide_either_a_userid_or':
    'please provide either a userId or groupId and both',
  'error.user.you_must_provide_a_password_to':
    'You must provide a password to change your email',
  'error.user.you_must_provide_the_correct_password':
    'You must provide the correct password to change your email',
  'error.user.a_user_with_this_email_already':
    'A user with this email already exists',
  'error.workspace.invitation_not_found': 'Invitation not found',
  'error.workspace.an_error_occurred_while_processing_the':
    'An error occurred while processing the invitations.',
  'error.workspace.invalid_invitation_token': 'Invalid invitation token',
  'error.workspace.invitation_already_accepted': 'Invitation already accepted',
  'error.workspace.failed_to_accept_invitation_an_error':
    'Failed to accept invitation. An error occurred.',
  'error.workspace.sso_provider_required':
    'There must be at least one active SSO provider to enforce SSO.',
  'error.workspace.hostname_already_exists': 'Hostname already exists.',
  'error.workspace.failed_to_activate_make_sure_pgvector':
    'Failed to activate. Make sure pgvector postgres extension is installed.',
  'error.workspace.workspace_member_not_found': 'Workspace member not found',
  'error.workspace.sso_provider_required_2':
    'There must be at least one workspace owner',
  'error.workspace.hostname_not_found': 'Hostname not found',
  'error.workspace.user_is_already_deactivated': 'User is already deactivated',
  'error.workspace.you_cannot_deactivate_yourself':
    'You cannot deactivate yourself',
  'error.workspace.you_cannot_deactivate_a_user_with':
    'You cannot deactivate a user with owner role',
  'error.workspace.user_is_not_deactivated': 'User is not deactivated',
  'error.workspace.you_cannot_activate_a_user_with':
    'You cannot activate a user with owner role',
  'error.workspace.you_cannot_delete_yourself': 'You cannot delete yourself',
  'error.workspace.you_cannot_delete_a_user_with':
    'You cannot delete a user with owner role',

  // Отказы ee, интеграций и прочего, переведенные тем же пакетом.
  'error.collaboration.invalid_collab_token': 'Invalid collab token',
  'error.common.invalid_user': 'Invalid User',
  'error.common.invalid_workspace': 'Invalid workspace',
  'error.common.invalid_multipart_content_type':
    'Invalid multipart content type',
  'error.common.workspace_not_found': 'Workspace not found',
  'error.database.group_not_found': 'Group not found',
  'error.database.user_not_found': 'User not found',
  'error.database.user_is_already_a_member_of':
    'User is already a member of this group',
  'error.database.please_provide_a_userid_or_groupid':
    'Please provide a userId or groupId',
  'error.ai_chat.chat_not_found': 'Chat not found',
  'error.ai_chat.access_denied': 'Access denied',
  'error.common.ai_is_not_configured': 'AI is not configured',
  'error.ai.ai_is_not_configured_set_it':
    'AI is not configured. Set it up in Settings → AI, or set AI_DRIVER in your environment.',
  'error.ai.select_a_provider_first': 'Select a provider first.',
  'error.ai.enter_an_api_key_first': 'Enter an API key first.',
  'error.ai.enter_an_embedding_api_key_first':
    'Enter an embedding API key first.',
  'error.common.base_not_found': 'Base not found',
  'error.common.pageid_is_required': 'pageId is required',
  'error.common.spaceid_or_parentpageid_is_required':
    'spaceId or parentPageId is required',
  'error.common.parent_page_not_found': 'Parent page not found',
  'error.base.parent_page_belongs_to_a_different':
    'Parent page belongs to a different space',
  'error.base.row_not_found': 'Row not found',
  'error.docx_export.page_content_is_empty': 'Page content is empty',
  'error.embedding.semantic_search_needs_an_embedding_api':
    'Semantic search needs an embedding API key. Set one in Settings → AI, or set OPENAI_API_KEY.',
  'error.mcp.mcp_is_disabled_for_this_workspace':
    'MCP is disabled for this workspace',
  'error.mcp.query_is_required': 'query is required',
  'error.mcp.you_can_only_delete_your_own':
    'You can only delete your own comments',
  'error.mcp.names_must_be_a_non_empty': 'names must be a non-empty array',
  'error.mcp.page_version_not_found': 'Page version not found',
  'error.mcp.page_is_already_in_this_space': 'Page is already in this space',
  'error.mcp.file_not_found': 'File not found',
  'error.mcp.filename_must_include_an_extension_e':
    'fileName must include an extension, e.g. "diagrama.png"',
  'error.mcp.error_processing_file_upload': 'Error processing file upload',
  'error.mcp.this_export_produced_an_archive_which':
    'This export produced an archive, which cannot be returned over MCP',
  'error.mcp.contentbase64_is_required': 'contentBase64 is required',
  'error.mcp.contentbase64_is_not_valid_base64':
    'contentBase64 is not valid base64',
  'error.mcp.contentbase64_decoded_to_an_empty_file':
    'contentBase64 decoded to an empty file',
  'error.mcp.content_must_be_a_markdown_string':
    'content must be a markdown string',
  'error.mcp.commentid_is_required': 'commentId is required',
  'error.mcp.comment_not_found': 'Comment not found',
  'error.mcp.label_not_found': 'Label not found',
  'error.mcp.labelid_or_name_is_required': 'labelId or name is required',
  'error.mcp.templateid_is_required': 'templateId is required',
  'error.mcp.invalid_favorite_type': 'Invalid favorite type',
  'error.mcp.semantic_search_needs_an_embedding_api':
    'Semantic search needs an embedding API key. Configure it in Settings → AI.',
  'error.mcp.rowids_must_be_a_non_empty': 'rowIds must be a non-empty array',
  'error.mcp.parentpageid_does_not_belong_to_the':
    'parentPageId does not belong to the given spaceId',
  'error.mfa.email_or_password_does_not_match':
    'Email or password does not match',
  'error.page_permission.provide_at_least_one_user_or':
    'Provide at least one user or group to grant access to',
  'error.page_permission.provide_at_least_one_user_or_2':
    'Provide at least one user or group to remove access from',
  'error.page_permission.provide_a_user_or_a_group':
    'Provide a user or a group',
  'error.page_permission.there_must_be_at_least_one_msg':
    'There must be at least one member with edit access to a restricted page',
  'error.page_permission.this_page_is_not_restricted':
    'This page is not restricted',
  'error.page_verification.verification_is_already_configured':
    'Verification is already configured',
  'error.page_verification.verification_not_found': 'Verification not found',
  'error.pdf_export.invalid_or_expired_render_token':
    'Invalid or expired render token',
  'error.pdf_export.export_not_found': 'Export not found',
  'error.pdf_export.export_has_no_pages': 'Export has no pages',
  'error.common.file_task_not_found': 'File task not found',
  'error.pdf_export.pdf_export_needs_gotenberg_url_to':
    'PDF export needs GOTENBERG_URL to point at a Gotenberg service.',
  'error.pdf_export.export_is_not_ready_yet': 'Export is not ready yet',
  'error.pdf_export.export_file_has_expired': 'Export file has expired',
  'error.scim.workspace_could_not_be_determined':
    'Workspace could not be determined',
  'error.scim.missing_or_malformed_authorization_header':
    'Missing or malformed Authorization header',
  'error.scim.scim_provisioning_is_disabled': 'SCIM provisioning is disabled',
  'error.scim.invalid_scim_token': 'Invalid SCIM token',
  'error.scim.displayname_is_required': 'displayName is required',
  'error.scim.username_must_be_a_valid_email':
    'userName must be a valid email address',
  'error.template.no_fields_to_update': 'No fields to update',
  'error.template.template_scope_changed_please_retry':
    'Template scope changed. Please retry',
  'error.template.template_not_found': 'Template not found',
  'error.template.invalid_content_format': 'Invalid content format',
  'error.integrations.no_pages_to_export': 'No pages to export',
  'error.integrations.no_accessible_pages_to_export':
    'No accessible pages to export',
  'error.integrations.root_page_is_not_accessible':
    'Root page is not accessible',
  'error.integrations.file_too_large_exceeds_the_10mb':
    'File too large. Exceeds the 10mb import limit',
  'error.integrations.failed_to_upload_file': 'Failed to upload file',
  'error.integrations.invalid_import_source_import_source_must':
    'Invalid import source. Import source must either be generic, notion or confluence.',
  'error.integrations.this_feature_requires_a_valid_enterprise':
    'This feature requires a valid enterprise license.',

  // Отказы с подстановкой значения в текст.
  'error.attachment.file_too_large':
    'File too large. Exceeds the {{limit}} limit',
  'error.auth.email_domain_not_approved':
    'The email domain "{{domain}}" is not approved for this workspace',
  'error.ai.unknown_driver': 'Unknown AI driver: {{driver}}',
  'error.ai.model_not_configured':
    'No model name is set for this AI provider',
  'error.ai.models_unavailable':
    'Could not list models from the provider: {{reason}}',
  'error.ai.embedding_models_unavailable':
    'Could not list embedding models: {{reason}}',
  'error.embedding.dimension_mismatch':
    'AI_EMBEDDING_DIMENSION is {{configured}} but the page_embeddings column is {{column}}. Change the variable or migrate the column.',
  'error.embedding.model_width_mismatch':
    'The embedding model returns {{length}} values, but the page_embeddings column is {{column}}. Pick a model of that width in Settings → AI.',
  'error.mcp.unknown_tool': 'Unknown tool: {{tool}}',
  'error.mcp.upload_too_large':
    'File too large for MCP upload (limit about {{limit}}MB). Upload it through the web interface instead.',
  'error.page_verification.transition_not_allowed':
    'Cannot {{action}} from status "{{status}}"',
  'error.integrations.import_type_unsupported':
    'Invalid import file type. Supported: {{supported}}.',
  'error.integrations.import_file_too_large':
    'File too large. Exceeds the {{limit}} import limit',
  'error.integrations.import_extension_unsupported':
    'Invalid import file extension. Supported: {{supported}}.',
  'error.group.you_cannot_change_an_external_group':
    'This group is managed by the directory and cannot be changed here',
  'error.group.you_cannot_delete_an_external_group':
    'This group is managed by the directory and cannot be deleted here',
  'error.group.this_group_is_not_managed_by_a_directory':
    'This group is not managed by a directory',
  'error.ai_chat.no_pending_plan':
    'This message has no plan waiting for a decision',
  'error.ai_chat.plan_already_resolved':
    'A decision on this plan has already been made',
} as const;

export type ErrorCode = keyof typeof ErrorMessage;

/** Подставить значения в запасной текст. */
function render(code: ErrorCode, params?: ErrorParams): string {
  const template: string = ErrorMessage[code];
  if (!params) return template;

  return template.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
    name in params ? String(params[name]) : whole,
  );
}

function body(code: ErrorCode, params?: ErrorParams) {
  return params
    ? { message: render(code, params), code, params }
    : { message: render(code), code };
}

export function badRequest(code: ErrorCode, params?: ErrorParams) {
  return new BadRequestException(body(code, params));
}

export function unauthorized(code: ErrorCode, params?: ErrorParams) {
  return new UnauthorizedException(body(code, params));
}

export function notFound(code: ErrorCode, params?: ErrorParams) {
  return new NotFoundException(body(code, params));
}

export function forbidden(code: ErrorCode, params?: ErrorParams) {
  return new ForbiddenException(body(code, params));
}

export function conflict(code: ErrorCode, params?: ErrorParams) {
  return new ConflictException(body(code, params));
}

export function serviceUnavailable(code: ErrorCode, params?: ErrorParams) {
  return new ServiceUnavailableException(body(code, params));
}
