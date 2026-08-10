export enum QueueName {
  EMAIL_QUEUE = '{email-queue}',
  ATTACHMENT_QUEUE = '{attachment-queue}',
  GENERAL_QUEUE = '{general-queue}',
  BILLING_QUEUE = '{billing-queue}',
  FILE_TASK_QUEUE = '{file-task-queue}',
  AI_QUEUE = '{ai-queue}',
  HISTORY_QUEUE = '{history-queue}',
  NOTIFICATION_QUEUE = '{notification-queue}',
  AUDIT_QUEUE = '{audit-queue}',
  BASE_QUEUE = '{base-queue}',
}

export enum QueueJob {
  SEND_EMAIL = 'send-email',
  DELETE_SPACE_ATTACHMENTS = 'delete-space-attachments',
  ATTACHMENT_INDEX_CONTENT = 'attachment-index-content',
  ATTACHMENT_INDEXING = 'attachment-indexing',
  DELETE_PAGE_ATTACHMENTS = 'delete-page-attachments',
  DELETE_AI_CHAT_ATTACHMENTS = 'delete-ai-chat-attachments',

  DELETE_USER_AVATARS = 'delete-user-avatars',

  PAGE_BACKLINKS = 'page-backlinks',
  ADD_PAGE_WATCHERS = 'add-page-watchers',

  STRIPE_SEATS_SYNC = 'sync-stripe-seats',
  TRIAL_ENDED = 'trial-ended',
  WELCOME_EMAIL = 'welcome-email',

  IMPORT_TASK = 'import-task',

  PAGE_CREATED = 'page-created',
  PAGE_CONTENT_UPDATED = 'page-content-updated',
  PAGE_MOVED_TO_SPACE = 'page-moved-to-space',
  PAGE_UPDATED = 'page-updated',
  PAGE_SOFT_DELETED = 'page-soft-deleted',
  PAGE_RESTORED = 'page-restored',
  PAGE_DELETED = 'page-deleted',

  SPACE_DELETED = 'space-deleted',

  WORKSPACE_DELETED = 'workspace-deleted',
  WORKSPACE_CREATE_EMBEDDINGS = 'workspace-create-embeddings',
  WORKSPACE_DELETE_EMBEDDINGS = 'workspace-delete-embeddings',

  PAGE_HISTORY = 'page-history',

  COMMENT_NOTIFICATION = 'comment-notification',
  COMMENT_RESOLVED_NOTIFICATION = 'comment-resolved-notification',
  PAGE_MENTION_NOTIFICATION = 'page-mention-notification',
  PAGE_PERMISSION_GRANTED = 'page-permission-granted',
  PAGE_UPDATE_DIGEST = 'page-update-digest',
  PAGE_VERIFICATION_EXPIRING = 'page-verification-expiring',
  PAGE_VERIFICATION_EXPIRED = 'page-verification-expired',
  PAGE_VERIFIED_NOTIFICATION = 'page-verified-notification',
  PAGE_APPROVAL_REQUESTED_NOTIFICATION = 'page-approval-requested-notification',
  PAGE_APPROVAL_REJECTED_NOTIFICATION = 'page-approval-rejected-notification',

  AUDIT_LOG = 'audit-log',
  AUDIT_CLEANUP = 'audit-cleanup',

  PDF_EXPORT_TASK = 'pdf-export-task',
  PDF_EXPORT_CLEANUP = 'pdf-export-cleanup',
}
