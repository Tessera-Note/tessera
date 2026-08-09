import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@tessera/db/types/kysely.types';
import { PageService } from '../../core/page/services/page.service';
import {
  ContentOperation,
  UpdatePageDto,
} from '../../core/page/dto/update-page.dto';
import { ContentFormat } from '../../core/page/dto/create-page.dto';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { PageRepo } from '@tessera/db/repos/page/page.repo';
import { PagePermissionRepo } from '@tessera/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@tessera/db/repos/space/space-member.repo';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../core/casl/interfaces/space-ability.type';
import { BaseService } from '../base/base.service';
import { SearchService } from '../../core/search/search.service';
import { SearchDTO } from '../../core/search/dto/search.dto';
import { CommentService } from '../../core/comment/comment.service';
import { CommentRepo } from '@tessera/db/repos/comment/comment.repo';
import { LabelService } from '../../core/label/label.service';
import { LabelRepo, LabelType } from '@tessera/db/repos/label/label.repo';
import { FavoriteService } from '../../core/favorite/services/favorite.service';
import { FavoriteType } from '@tessera/db/repos/favorite/favorite.repo';
import { PageHistoryService } from '../../core/page/services/page-history.service';
import { BacklinkService } from '../../core/page/services/backlink.service';
import { TemplateService } from '../template/template.service';
import { SearchAttachmentsService } from '../search-attachments/search-attachments.service';
import { AttachmentRepo } from '@tessera/db/repos/attachment/attachment.repo';
import { AttachmentService } from '../../core/attachment/services/attachment.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { MultipartFile } from '@fastify/multipart';
import { Readable } from 'stream';
import { ExportService } from '../../integrations/export/export.service';
import { ExportFormat } from '../../integrations/export/dto/export-dto';
import { WsService } from '../../ws/ws.service';
import { PaginationOptions } from '@tessera/db/pagination/pagination-options';
import {
  htmlToJson,
  jsonToHtml,
  jsonToMarkdown,
  jsonToText,
} from '../../collaboration/collaboration.util';
import { sql } from 'kysely';
import { markdownToHtml } from '@tessera/editor-ext';
import { Page, User, Workspace } from '@tessera/db/types/entity.types';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { getPageTitle } from '../../common/helpers';
import { badRequest, forbidden, notFound } from '../../common/errors/app-error';

/**
 * Every revision we've tested against. Our initialize/tools/list/tools/call
 * shape is a lowest-common-denominator subset (no resources, no batching, no
 * server-initiated requests) that all three revisions accept as-is, so the
 * safe move is to echo back whatever the client asked for.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';

/** Mirrors BasePropertyType on the client (apps/client/src/ee/base/types/base.types.ts). */
const BASE_PROPERTY_TYPES = [
  'text',
  'longText',
  'number',
  'select',
  'multiSelect',
  'status',
  'date',
  'person',
  'file',
  'page',
  'checkbox',
  'url',
  'email',
  'createdAt',
  'lastEditedAt',
  'lastEditedBy',
  'formula',
];

const BASE_VIEW_TYPES = ['table', 'kanban', 'calendar'];

/** Base64 is ~4/3 the size of the bytes it encodes. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BASE64_CHARS = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3);

@Injectable()
export class McpService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageService: PageService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly baseService: BaseService,
    private readonly searchService: SearchService,
    private readonly commentService: CommentService,
    private readonly commentRepo: CommentRepo,
    private readonly labelService: LabelService,
    private readonly labelRepo: LabelRepo,
    private readonly favoriteService: FavoriteService,
    private readonly pageHistoryService: PageHistoryService,
    private readonly backlinkService: BacklinkService,
    private readonly templateService: TemplateService,
    private readonly searchAttachmentsService: SearchAttachmentsService,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly attachmentService: AttachmentService,
    private readonly embeddingService: EmbeddingService,
    private readonly exportService: ExportService,
    private readonly wsService: WsService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async handleRpcRequest(body: any, user: User, workspace: Workspace) {
    const { id, method, params } = body || {};

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: this.negotiateProtocolVersion(
            params?.protocolVersion,
          ),
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'Tessera MCP Server',
            version: '1.0.0',
          },
        },
      };
    }

    if (method === 'notifications/initialized') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: this.getToolsList(),
        },
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      try {
        const result = await this.callTool(toolName, toolArgs, user, workspace);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text:
                  typeof result === 'string'
                    ? result
                    : JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      } catch (err: any) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Error executing tool '${toolName}': ${this.toToolErrorMessage(err)}`,
              },
            ],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method '${method}' not found`,
      },
    };
  }

  /**
   * Permission failures surface as bare ForbiddenException with no message.
   * Give the agent something actionable instead of an empty string.
   */
  private toToolErrorMessage(err: any): string {
    if (err instanceof ForbiddenException) {
      return 'You do not have permission to perform this action.';
    }
    return err?.message || 'Unknown error';
  }

  /**
   * Echo the client's requested version when we know it, instead of a fixed
   * '2024-11-05'. A hardcoded old version made streamable-HTTP clients
   * (Codex among them, which requires 2025-03-26+ for that transport) treat
   * the server as incompatible and refuse to proceed, even though the actual
   * request/response shape we send works unchanged across all three
   * revisions. Falls back to the latest known version for a client we've
   * never seen, per the spec's negotiation rule.
   */
  private negotiateProtocolVersion(requested: unknown): string {
    if (
      typeof requested === 'string' &&
      SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ) {
      return requested;
    }
    return LATEST_PROTOCOL_VERSION;
  }

  private getToolsList() {
    return [
      ...this.getPageToolsList(),
      ...this.getBaseToolsList(),
      ...this.getWorkspaceToolsList(),
    ];
  }

  /**
   * Comments, labels, favorites, history, page organization, templates,
   * attachments and export.
   */
  private getWorkspaceToolsList() {
    return [
      // --- comments ---
      {
        name: 'list_page_comments',
        description: 'List the comments on a page, newest first.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID or slug ID' },
            limit: {
              type: 'number',
              description: 'Max comments. Defaults to 20.',
            },
            cursor: {
              type: 'string',
              description: 'Cursor from a previous response',
            },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'get_comment',
        description: 'Get a single comment by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            commentId: { type: 'string', description: 'Comment ID' },
          },
          required: ['commentId'],
        },
      },
      {
        name: 'create_comment',
        description:
          'Add a comment to a page, or reply to an existing comment. Replies to a reply are not allowed.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID or slug ID' },
            content: {
              type: 'string',
              description: 'Comment body in markdown',
            },
            parentCommentId: {
              type: 'string',
              description: 'Optional comment ID to reply to',
            },
          },
          required: ['pageId', 'content'],
        },
      },
      {
        name: 'update_comment',
        description: 'Edit a comment. You can only edit your own comments.',
        inputSchema: {
          type: 'object',
          properties: {
            commentId: { type: 'string', description: 'Comment ID' },
            content: {
              type: 'string',
              description: 'New comment body in markdown',
            },
          },
          required: ['commentId', 'content'],
        },
      },
      {
        name: 'delete_comment',
        description:
          "Delete a comment. You can delete your own comments; deleting someone else's requires space admin.",
        inputSchema: {
          type: 'object',
          properties: {
            commentId: { type: 'string', description: 'Comment ID' },
          },
          required: ['commentId'],
        },
      },

      // --- labels ---
      {
        name: 'list_page_labels',
        description: 'List the labels attached to a page.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID or slug ID' },
            limit: {
              type: 'number',
              description: 'Max labels. Defaults to 20.',
            },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'add_page_labels',
        description:
          'Attach labels to a page, creating any that do not exist yet. Names may contain only lowercase letters, digits, hyphens, underscores and tildes, and cannot start with a tilde.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID or slug ID' },
            names: {
              type: 'array',
              items: { type: 'string' },
              description: 'Label names, up to 25 per call',
            },
          },
          required: ['pageId', 'names'],
        },
      },
      {
        name: 'remove_page_label',
        description: 'Detach a label from a page.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID or slug ID' },
            labelId: { type: 'string', description: 'Label ID' },
          },
          required: ['pageId', 'labelId'],
        },
      },
      {
        name: 'list_labels',
        description: 'List the page labels available in the workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Max labels. Defaults to 20.',
            },
            cursor: {
              type: 'string',
              description: 'Cursor from a previous response',
            },
          },
        },
      },
      {
        name: 'find_pages_by_label',
        description:
          'Find pages carrying a label, given either its ID or its name. Only pages the user can access are returned.',
        inputSchema: {
          type: 'object',
          properties: {
            labelId: { type: 'string', description: 'Label ID' },
            name: {
              type: 'string',
              description: 'Label name, if the ID is unknown',
            },
            spaceId: {
              type: 'string',
              description: 'Optional space to restrict to',
            },
            limit: {
              type: 'number',
              description: 'Max pages. Defaults to 20.',
            },
          },
        },
      },

      // --- favorites ---
      {
        name: 'list_favorites',
        description: "List the authenticated user's favorites.",
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['page', 'space', 'template'],
              description: 'Optional type filter',
            },
            spaceId: { type: 'string', description: 'Optional space filter' },
            limit: {
              type: 'number',
              description: 'Max favorites. Defaults to 20.',
            },
          },
        },
      },
      {
        name: 'add_favorite',
        description:
          'Favorite a page, space or template. Pass the ID matching the chosen type.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['page', 'space', 'template'] },
            pageId: {
              type: 'string',
              description: 'Required when type is page',
            },
            spaceId: {
              type: 'string',
              description: 'Required when type is space',
            },
            templateId: {
              type: 'string',
              description: 'Required when type is template',
            },
          },
          required: ['type'],
        },
      },
      {
        name: 'remove_favorite',
        description: 'Remove a page, space or template from the favorites.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['page', 'space', 'template'] },
            pageId: {
              type: 'string',
              description: 'Required when type is page',
            },
            spaceId: {
              type: 'string',
              description: 'Required when type is space',
            },
            templateId: {
              type: 'string',
              description: 'Required when type is template',
            },
          },
          required: ['type'],
        },
      },

      // --- history and trash ---
      {
        name: 'list_page_history',
        description: 'List the saved versions of a page, newest first.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID or slug ID' },
            limit: {
              type: 'number',
              description: 'Max versions. Defaults to 20.',
            },
            cursor: {
              type: 'string',
              description: 'Cursor from a previous response',
            },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'get_page_version',
        description:
          'Get one saved version of a page, including its content. Content is markdown by default.',
        inputSchema: {
          type: 'object',
          properties: {
            historyId: {
              type: 'string',
              description: 'Version ID from list_page_history',
            },
            format: {
              type: 'string',
              enum: ['markdown', 'html', 'json'],
              description: 'Output format. Defaults to markdown.',
            },
          },
          required: ['historyId'],
        },
      },
      {
        name: 'list_trash',
        description:
          'List the deleted pages of a space. Requires edit permission on the space.',
        inputSchema: {
          type: 'object',
          properties: {
            spaceId: { type: 'string', description: 'Space ID' },
            limit: {
              type: 'number',
              description: 'Max pages. Defaults to 20.',
            },
            cursor: {
              type: 'string',
              description: 'Cursor from a previous response',
            },
          },
          required: ['spaceId'],
        },
      },
      {
        name: 'restore_page',
        description: 'Restore a page from the trash.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: {
              type: 'string',
              description: 'Page ID of a trashed page',
            },
          },
          required: ['pageId'],
        },
      },

      // --- page organization ---
      {
        name: 'move_page',
        description:
          'Move a page within its space: reparent it, reorder it, or both. Position is a fractional index string of 5 to 12 characters; read the siblings with list_pages and pick a value that sorts where you want the page to land.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID to move' },
            position: {
              type: 'string',
              description: 'New fractional index position',
            },
            parentPageId: {
              type: 'string',
              description:
                'New parent page ID. Omit to keep the current parent.',
            },
          },
          required: ['pageId', 'position'],
        },
      },
      {
        name: 'move_page_to_space',
        description:
          'Move a page and its subtree to another space. Child pages the user cannot access stay behind as root pages in the original space.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID to move' },
            spaceId: { type: 'string', description: 'Destination space ID' },
          },
          required: ['pageId', 'spaceId'],
        },
      },
      {
        name: 'duplicate_page',
        description:
          'Duplicate a page and its subtree, in the same space or into another one. Inaccessible child branches are skipped.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID to duplicate' },
            spaceId: {
              type: 'string',
              description: 'Destination space ID. Omit to duplicate in place.',
            },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'get_page_breadcrumbs',
        description: 'Get the ancestor chain of a page, from the root down.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID or slug ID' },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'get_page_backlinks',
        description:
          'List pages linking to this page (incoming) or linked from it (outgoing).',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID or slug ID' },
            direction: {
              type: 'string',
              enum: ['incoming', 'outgoing'],
              description: 'Link direction. Defaults to incoming.',
            },
            limit: {
              type: 'number',
              description: 'Max links. Defaults to 20.',
            },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'list_recent_pages',
        description:
          "List recently updated pages, across the user's spaces or within one space.",
        inputSchema: {
          type: 'object',
          properties: {
            spaceId: { type: 'string', description: 'Optional space filter' },
            limit: {
              type: 'number',
              description: 'Max pages. Defaults to 20.',
            },
            cursor: {
              type: 'string',
              description: 'Cursor from a previous response',
            },
          },
        },
      },

      // --- templates ---
      {
        name: 'list_templates',
        description:
          'List the templates the user can reach: workspace-wide ones plus those in their spaces.',
        inputSchema: {
          type: 'object',
          properties: {
            spaceId: { type: 'string', description: 'Optional space filter' },
            limit: {
              type: 'number',
              description: 'Max templates. Defaults to 20.',
            },
            cursor: {
              type: 'string',
              description: 'Cursor from a previous response',
            },
          },
        },
      },
      {
        name: 'get_template',
        description: 'Get a template with its content.',
        inputSchema: {
          type: 'object',
          properties: {
            templateId: { type: 'string', description: 'Template ID' },
          },
          required: ['templateId'],
        },
      },
      {
        name: 'create_template',
        description:
          'Create a template. Scoped to a space when spaceId is given, otherwise workspace-wide, which requires workspace settings permission.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Template title' },
            content: {
              type: 'string',
              description: 'Template body in markdown',
            },
            description: {
              type: 'string',
              description: 'Optional description',
            },
            icon: { type: 'string', description: 'Optional icon' },
            spaceId: {
              type: 'string',
              description: 'Optional space to scope it to',
            },
          },
          required: ['title'],
        },
      },
      {
        name: 'update_template',
        description: 'Update a template title, description, icon or content.',
        inputSchema: {
          type: 'object',
          properties: {
            templateId: { type: 'string', description: 'Template ID' },
            title: { type: 'string', description: 'Optional new title' },
            content: {
              type: 'string',
              description: 'Optional new body in markdown',
            },
            description: {
              type: 'string',
              description: 'Optional new description',
            },
            icon: { type: 'string', description: 'Optional new icon' },
          },
          required: ['templateId'],
        },
      },
      {
        name: 'delete_template',
        description: 'Delete a template.',
        inputSchema: {
          type: 'object',
          properties: {
            templateId: { type: 'string', description: 'Template ID' },
          },
          required: ['templateId'],
        },
      },
      {
        name: 'use_template',
        description: 'Create a new page in a space from a template.',
        inputSchema: {
          type: 'object',
          properties: {
            templateId: { type: 'string', description: 'Template ID' },
            spaceId: {
              type: 'string',
              description: 'Space to create the page in',
            },
            parentPageId: {
              type: 'string',
              description: 'Optional parent page ID',
            },
          },
          required: ['templateId', 'spaceId'],
        },
      },

      // --- attachments and export ---
      {
        name: 'search_attachments',
        description:
          'Full-text search inside the content of uploaded files, across the spaces the user can access. Returns the file and the page it is attached to.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term' },
            spaceId: {
              type: 'string',
              description: 'Optional space to restrict to',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_attachment_info',
        description: 'Get the metadata of an uploaded file.',
        inputSchema: {
          type: 'object',
          properties: {
            attachmentId: { type: 'string', description: 'Attachment ID' },
          },
          required: ['attachmentId'],
        },
      },
      {
        name: 'upload_attachment',
        description:
          'Attach a file or image to a page, sent as base64. Meant for small artefacts the agent produces: screenshots, diagrams, generated CSVs. Base64 inflates payloads by about a third and everything sent here passes through the model context, so the cap is deliberately low — upload large documents through the web UI instead. Returns the attachment ID and its URL.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: {
              type: 'string',
              description: 'Page to attach the file to. Requires edit access.',
            },
            fileName: {
              type: 'string',
              description:
                'File name including extension, e.g. "diagrama.png". The extension decides the content type.',
            },
            contentBase64: {
              type: 'string',
              description:
                'File bytes, base64 encoded, without a data: URI prefix',
            },
          },
          required: ['pageId', 'fileName', 'contentBase64'],
        },
      },
      {
        name: 'export_page',
        description:
          'Export a single page as markdown or html, with internal links rewritten. Exports covering child pages or attachments produce a zip archive and are not available over MCP — read children individually with get_page instead.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID or slug ID' },
            format: {
              type: 'string',
              enum: ['markdown', 'html'],
              description: 'Export format. Defaults to markdown.',
            },
          },
          required: ['pageId'],
        },
      },
    ];
  }

  private getPageToolsList() {
    return [
      {
        name: 'list_spaces',
        description:
          'List the spaces the authenticated user is a member of in the Tessera workspace.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_pages',
        description:
          'List pages the authenticated user can access, optionally scoped to a space.',
        inputSchema: {
          type: 'object',
          properties: {
            spaceId: {
              type: 'string',
              description: 'Optional space ID filter',
            },
          },
        },
      },
      {
        name: 'get_page',
        description:
          'Retrieve full content and metadata of a page by pageId or slugId. Content is returned as markdown by default.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID or slug ID' },
            format: {
              type: 'string',
              enum: ['markdown', 'html', 'json'],
              description:
                'Output format for the content. Defaults to markdown. Use json only when you need the raw ProseMirror document.',
            },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'create_page',
        description: 'Create a new page in a space.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Page title' },
            content: {
              type: 'string',
              description: 'Markdown content of the page',
            },
            spaceId: {
              type: 'string',
              description: 'Space ID where page will be created',
            },
            parentPageId: {
              type: 'string',
              description: 'Optional parent page ID',
            },
          },
          required: ['title', 'spaceId'],
        },
      },
      {
        name: 'update_page',
        description: 'Update content or title of an existing page.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID to update' },
            title: { type: 'string', description: 'Optional new title' },
            content: {
              type: 'string',
              description: 'Optional markdown content',
            },
            operation: {
              type: 'string',
              enum: ['append', 'prepend', 'replace'],
              description:
                'Content operation: append (default), prepend, or replace',
            },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'delete_page',
        description: 'Move a page to the trash by pageId.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID to delete' },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'search_workspace',
        description:
          'Full-text search over page titles and body content, ranked by relevance, across the spaces the authenticated user can access. Each result carries a highlight snippet showing the match in context.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term or keyword' },
            spaceId: {
              type: 'string',
              description: 'Optional space ID to restrict the search to',
            },
            limit: {
              type: 'number',
              description: 'Max results. Defaults to 25.',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  /**
   * Bases are Tessera's database pages (table / kanban / calendar). A base is
   * itself a page, so every tool below authorizes against that page.
   */
  private getBaseToolsList() {
    return [
      {
        name: 'search_semantic',
        description:
          'Find pages by meaning rather than by wording. Use this when the question is conceptual and you cannot guess the exact terms the page uses — "how do we handle unhappy customers" will reach a page titled "Complaints policy" even though no word matches. For a known term or a proper noun, search_workspace is sharper. Each hit carries a similarity score between 0 and 1 and the passage that matched.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'The question or idea to look for, in natural language. Full sentences work better here than keywords.',
            },
            spaceId: {
              type: 'string',
              description: 'Optional space to restrict to',
            },
            limit: {
              type: 'number',
              description: 'Max pages. Defaults to 10.',
            },
            minSimilarity: {
              type: 'number',
              description:
                'Drop hits below this score, 0 to 1. Defaults to 0.2. Raise it if results feel loose.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'reindex_embeddings',
        description:
          'Build the semantic index for pages that do not have one yet, and report coverage. Run it once after enabling semantic search; afterwards pages are indexed automatically when saved. Indexes in batches, so call it again while pending is above zero.',
        inputSchema: {
          type: 'object',
          properties: {
            batchSize: {
              type: 'number',
              description:
                'Pages to index in this call. Defaults to 25, max 100.',
            },
          },
        },
      },
      {
        name: 'search_everything',
        description:
          'Broad keyword sweep across the whole workspace in one call: pages (title and body), kanban / table rows, comments and uploaded files. Use this first when you do not know where something lives. Pages are ranked by relevance; rows and comments are plain substring matches, so they carry no ranking.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keyword or phrase' },
            spaceId: {
              type: 'string',
              description: 'Optional space to restrict the whole sweep to',
            },
            limitPerType: {
              type: 'number',
              description: 'Max hits per category. Defaults to 10.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'create_base',
        description:
          'Create a base (database page) in a space or as a sub-page. A kanban base comes with a "Status" select property and a board view; a table base comes with a grid view.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Base name' },
            spaceId: {
              type: 'string',
              description: 'Space ID. Required unless parentPageId is given.',
            },
            parentPageId: {
              type: 'string',
              description: 'Optional parent page ID',
            },
            template: {
              type: 'string',
              enum: ['kanban', 'table'],
              description: 'Base template. Defaults to table.',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'list_bases',
        description:
          'List all bases in a space, with their properties and views.',
        inputSchema: {
          type: 'object',
          properties: {
            spaceId: { type: 'string', description: 'Space ID' },
          },
          required: ['spaceId'],
        },
      },
      {
        name: 'get_base',
        description:
          'Get a base with its full schema: properties (columns) and views. Call this before creating or updating rows so you know the property IDs to use as cell keys.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'update_base',
        description: 'Rename a base.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            name: { type: 'string', description: 'New base name' },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'delete_base',
        description: 'Move a base to the trash.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'convert_page_to_base',
        description: 'Convert an existing regular page into a base.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Page ID to convert' },
            template: {
              type: 'string',
              enum: ['kanban', 'table'],
              description: 'View to create. Defaults to table.',
            },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'export_base_csv',
        description: 'Export all rows of a base as CSV text.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'create_base_property',
        description:
          'Add a property (column) to a base. For select/multiSelect/status, pass typeOptions with a "choices" array of {id, name, color}.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            name: { type: 'string', description: 'Property name' },
            type: {
              type: 'string',
              enum: BASE_PROPERTY_TYPES,
              description: 'Property type',
            },
            typeOptions: {
              type: 'object',
              description:
                'Type-specific configuration, e.g. { "choices": [{ "id": "todo", "name": "To Do", "color": "gray" }] } for select.',
            },
          },
          required: ['pageId', 'name', 'type'],
        },
      },
      {
        name: 'update_base_property',
        description:
          'Rename a property, change its type, or change its typeOptions.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            propertyId: { type: 'string', description: 'Property ID' },
            name: { type: 'string', description: 'Optional new name' },
            type: {
              type: 'string',
              enum: BASE_PROPERTY_TYPES,
              description: 'Optional new type',
            },
            typeOptions: {
              type: 'object',
              description: 'Optional new type options',
            },
          },
          required: ['pageId', 'propertyId'],
        },
      },
      {
        name: 'delete_base_property',
        description: 'Delete a property (column) from a base.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            propertyId: { type: 'string', description: 'Property ID' },
          },
          required: ['pageId', 'propertyId'],
        },
      },
      {
        name: 'reorder_base_property',
        description:
          'Move a property to a new position. Position is a fractional index string (e.g. "h1"); read the current positions with get_base and pick a value that sorts between the two neighbours.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            propertyId: { type: 'string', description: 'Property ID' },
            position: {
              type: 'string',
              description: 'New fractional index position',
            },
          },
          required: ['pageId', 'propertyId', 'position'],
        },
      },
      {
        name: 'create_base_row',
        description:
          'Create a row (card / record) in a base. "cells" is keyed by property ID, not by property name — get the IDs from get_base first.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            cells: {
              type: 'object',
              description:
                'Cell values keyed by property ID, e.g. { "a1b2c3d4": "My task" }',
            },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'get_base_row',
        description: 'Get a single row of a base by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            rowId: { type: 'string', description: 'Row ID' },
          },
          required: ['pageId', 'rowId'],
        },
      },
      {
        name: 'list_base_rows',
        description:
          'List rows of a base. Cells are keyed by property ID. Supports an optional filter and cursor pagination — when meta.hasMore is true, call again with meta.nextCursor.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            limit: {
              type: 'number',
              description: 'Max rows to return. Defaults to 50.',
            },
            cursor: {
              type: 'string',
              description: 'Cursor from a previous meta.nextCursor',
            },
            filter: {
              type: 'object',
              description:
                'Filter tree. Leaf: { "propertyId": "...", "op": "eq" | "neq" | "isEmpty" | "isNotEmpty", "value": ... }. Group: { "op": "and" | "or", "children": [ ... ] }.',
            },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'update_base_row',
        description:
          'Update cells of a row. Cells are merged into the existing ones, so you only need to send the properties you want to change.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            rowId: { type: 'string', description: 'Row ID' },
            cells: {
              type: 'object',
              description: 'Cell values to merge, keyed by property ID',
            },
          },
          required: ['pageId', 'rowId', 'cells'],
        },
      },
      {
        name: 'delete_base_row',
        description: 'Delete a single row from a base.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            rowId: { type: 'string', description: 'Row ID' },
          },
          required: ['pageId', 'rowId'],
        },
      },
      {
        name: 'delete_base_rows',
        description: 'Delete several rows from a base in one call.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            rowIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Row IDs to delete',
            },
          },
          required: ['pageId', 'rowIds'],
        },
      },
      {
        name: 'reorder_base_row',
        description:
          'Move a row to a new position. Position is a fractional index string; read the neighbouring rows with list_base_rows and pick a value that sorts between them.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            rowId: { type: 'string', description: 'Row ID' },
            position: {
              type: 'string',
              description: 'New fractional index position',
            },
          },
          required: ['pageId', 'rowId', 'position'],
        },
      },
      {
        name: 'list_base_views',
        description: 'List the views of a base.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
          },
          required: ['pageId'],
        },
      },
      {
        name: 'create_base_view',
        description:
          'Create a view on a base. A kanban view needs config.groupByPropertyId pointing at a select or status property.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            name: { type: 'string', description: 'View name' },
            type: {
              type: 'string',
              enum: BASE_VIEW_TYPES,
              description: 'View type. Defaults to table.',
            },
            config: {
              type: 'object',
              description:
                'View configuration, e.g. { "groupByPropertyId": "<select property id>" } for kanban.',
            },
          },
          required: ['pageId', 'name'],
        },
      },
      {
        name: 'update_base_view',
        description:
          'Rename a view, change its type, or update its configuration.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            viewId: { type: 'string', description: 'View ID' },
            name: { type: 'string', description: 'Optional new name' },
            type: {
              type: 'string',
              enum: BASE_VIEW_TYPES,
              description: 'Optional new view type',
            },
            config: {
              type: 'object',
              description: 'Optional new configuration',
            },
          },
          required: ['pageId', 'viewId'],
        },
      },
      {
        name: 'delete_base_view',
        description: 'Delete a view from a base.',
        inputSchema: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: 'Base page ID' },
            viewId: { type: 'string', description: 'View ID' },
          },
          required: ['pageId', 'viewId'],
        },
      },
    ];
  }

  /**
   * ProseMirror JSON is expensive for an agent to read and easy to
   * misinterpret, so markdown is the default wire format.
   */
  private renderPageContent(content: any, format: string) {
    if (!content || format === 'json') {
      return content;
    }

    return format === 'html' ? jsonToHtml(content) : jsonToMarkdown(content);
  }

  /**
   * Load a page and assert it belongs to the caller's workspace.
   * Workspace mismatch is reported as "not found" so the tool cannot be used
   * to probe for page IDs in other workspaces.
   */
  private async getPageInWorkspace(
    pageId: string,
    workspace: Workspace,
    opts?: { includeContent?: boolean },
  ): Promise<Page> {
    if (!pageId) {
      throw badRequest('error.common.pageid_is_required');
    }

    const page = await this.pageRepo.findById(pageId, {
      includeContent: opts?.includeContent,
    });

    if (!page || page.deletedAt || page.workspaceId !== workspace.id) {
      throw notFound('error.common.page_not_found');
    }

    return page;
  }

  private async assertCanCreateInSpace(
    user: User,
    spaceId: string,
  ): Promise<void> {
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  private async callTool(
    name: string,
    args: any,
    user: User,
    workspace: Workspace,
  ) {
    switch (name) {
      case 'list_spaces': {
        const spaceIds = await this.spaceMemberRepo.getUserSpaceIds(user.id);
        if (spaceIds.length === 0) {
          return { spaces: [] };
        }

        const spaces = await this.db
          .selectFrom('spaces')
          .select(['id', 'name', 'slug', 'description'])
          .where('id', 'in', spaceIds)
          .where('workspaceId', '=', workspace.id)
          .where('deletedAt', 'is', null)
          .execute();
        return { spaces };
      }

      case 'list_pages': {
        let spaceIds: string[];

        if (args.spaceId) {
          // createForUser throws when the user is not a member of the space
          const ability = await this.spaceAbility.createForUser(
            user,
            args.spaceId,
          );
          if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
            throw new ForbiddenException();
          }
          spaceIds = [args.spaceId];
        } else {
          spaceIds = await this.spaceMemberRepo.getUserSpaceIds(user.id);
        }

        if (spaceIds.length === 0) {
          return { pages: [] };
        }

        const pages = await this.db
          .selectFrom('pages')
          .select([
            'id',
            'title',
            'slugId',
            'spaceId',
            'parentPageId',
            'isBase',
            'createdAt',
            'updatedAt',
          ])
          .where('workspaceId', '=', workspace.id)
          .where('spaceId', 'in', spaceIds)
          .where('deletedAt', 'is', null)
          .limit(100)
          .execute();

        return {
          pages: await this.filterRestrictedPages(pages, user, args.spaceId),
        };
      }

      case 'get_page': {
        const page = await this.getPageInWorkspace(args.pageId, workspace, {
          includeContent: true,
        });

        await this.pageAccessService.validateCanView(page, user);

        const format = args.format || 'markdown';

        return {
          id: page.id,
          title: page.title,
          slugId: page.slugId,
          spaceId: page.spaceId,
          parentPageId: page.parentPageId,
          format,
          content: this.renderPageContent(page.content, format),
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
        };
      }

      case 'create_page': {
        if (!args.spaceId) {
          throw badRequest('error.common.spaceid_is_required');
        }

        if (args.parentPageId) {
          const parentPage = await this.getPageInWorkspace(
            args.parentPageId,
            workspace,
          );
          if (parentPage.spaceId !== args.spaceId) {
            throw notFound('error.common.parent_page_not_found');
          }
          await this.pageAccessService.validateCanEdit(parentPage, user);
        } else {
          await this.assertCanCreateInSpace(user, args.spaceId);
        }

        const page = await this.pageService.create(user.id, workspace.id, {
          title: args.title,
          spaceId: args.spaceId,
          parentPageId: args.parentPageId || undefined,
          content: args.content || '',
          format: 'markdown',
        });

        this.auditService.log({
          event: AuditEvent.PAGE_CREATED,
          resourceType: AuditResource.PAGE,
          resourceId: page.id,
          spaceId: page.spaceId,
          changes: {
            after: {
              title: getPageTitle(page.title),
              spaceId: page.spaceId,
            },
          },
        });

        return {
          success: true,
          pageId: page.id,
          title: page.title,
          slugId: page.slugId,
        };
      }

      case 'update_page': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);

        await this.pageAccessService.validateCanEdit(page, user);

        const hasContent = args.content !== undefined && args.content !== null;

        const updatePageDto: UpdatePageDto = {
          pageId: page.id,
          title: args.title,
          ...(hasContent && {
            content: args.content,
            operation: (args.operation || 'append') as ContentOperation,
            format: 'markdown' as ContentFormat,
          }),
        };

        const updatedPage = await this.pageService.update(
          page,
          updatePageDto,
          user,
        );

        return {
          success: true,
          pageId: updatedPage.id,
          title: updatedPage.title,
        };
      }

      case 'delete_page': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);

        await this.pageAccessService.validateCanEdit(page, user);

        await this.pageService.removePage(page.id, user.id, workspace.id);

        this.auditService.log({
          event: AuditEvent.PAGE_TRASHED,
          resourceType: AuditResource.PAGE,
          resourceId: page.id,
          spaceId: page.spaceId,
          changes: {
            before: {
              pageId: page.id,
              slugId: page.slugId,
              title: getPageTitle(page.title),
              spaceId: page.spaceId,
            },
          },
        });

        return { success: true, message: 'Page moved to trash' };
      }

      case 'search_workspace': {
        if (!args.query) {
          throw badRequest('error.mcp.query_is_required');
        }

        if (args.spaceId) {
          const ability = await this.spaceAbility.createForUser(
            user,
            args.spaceId,
          );
          if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
            throw new ForbiddenException();
          }
        }

        // searchPage scopes to the user's spaces and applies page-level
        // restrictions itself when userId is passed.
        const { items } = await this.searchService.searchPage(
          {
            query: args.query,
            spaceId: args.spaceId,
            limit: args.limit || 25,
          } as SearchDTO,
          { userId: user.id, workspaceId: workspace.id },
        );

        return {
          results: items.map((item: any) => ({
            id: item.id,
            title: item.title,
            slugId: item.slugId,
            spaceId: item.space?.id ?? item.spaceId,
            spaceName: item.space?.name,
            highlight: item.highlight,
          })),
        };
      }

      default:
        return this.callBaseTool(name, args, user, workspace);
    }
  }

  private async callWorkspaceTool(
    name: string,
    args: any,
    user: User,
    workspace: Workspace,
  ) {
    switch (name) {
      // --- comments ---
      case 'list_page_comments': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanView(page, user);

        return this.commentService.findByPageId(page.id, this.pagination(args));
      }

      case 'get_comment': {
        const { comment, page } = await this.getCommentInWorkspace(
          args.commentId,
          workspace,
        );
        await this.pageAccessService.validateCanView(page, user);
        return comment;
      }

      case 'create_comment': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanComment(
          page,
          user,
          workspace.id,
        );

        const comment = await this.commentService.create(
          { page, workspaceId: workspace.id, user },
          {
            pageId: page.id,
            content: await this.markdownToCommentContent(args.content),
            parentCommentId: args.parentCommentId,
            type: 'page',
          } as any,
        );

        this.auditService.log({
          event: AuditEvent.COMMENT_CREATED,
          resourceType: AuditResource.COMMENT,
          resourceId: comment.id,
          spaceId: page.spaceId,
          metadata: { pageId: page.id },
        });

        return comment;
      }

      case 'update_comment': {
        const { comment, page } = await this.getCommentInWorkspace(
          args.commentId,
          workspace,
        );
        await this.pageAccessService.validateCanComment(
          page,
          user,
          workspace.id,
        );

        // commentService.update rejects editing someone else's comment
        return this.commentService.update(
          comment,
          {
            commentId: comment.id,
            content: await this.markdownToCommentContent(args.content),
          },
          user,
        );
      }

      case 'delete_comment': {
        const { comment, page } = await this.getCommentInWorkspace(
          args.commentId,
          workspace,
        );
        await this.pageAccessService.validateCanComment(
          page,
          user,
          workspace.id,
        );

        if (comment.creatorId !== user.id) {
          const ability = await this.spaceAbility.createForUser(
            user,
            comment.spaceId,
          );
          if (
            ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)
          ) {
            throw forbidden('error.mcp.you_can_only_delete_your_own');
          }
        }

        await this.commentRepo.deleteComment(comment.id);

        this.wsService.emitCommentEvent(comment.spaceId, comment.pageId, {
          operation: 'commentDeleted',
          pageId: comment.pageId,
          commentId: comment.id,
        });

        this.auditService.log({
          event: AuditEvent.COMMENT_DELETED,
          resourceType: AuditResource.COMMENT,
          resourceId: comment.id,
          spaceId: comment.spaceId,
          changes: {
            before: { pageId: comment.pageId, creatorId: comment.creatorId },
          },
        });

        return { success: true, commentId: comment.id };
      }

      // --- labels ---
      case 'list_page_labels': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanView(page, user);

        return this.labelService.getPageLabels(page.id, this.pagination(args));
      }

      case 'add_page_labels': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanEdit(page, user);

        if (!Array.isArray(args.names) || args.names.length === 0) {
          throw badRequest('error.mcp.names_must_be_a_non_empty');
        }

        return {
          labels: await this.labelService.addLabelsToPage(
            page.id,
            args.names,
            workspace.id,
          ),
        };
      }

      case 'remove_page_label': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanEdit(page, user);

        await this.labelService.removeLabelFromPage(
          page.id,
          args.labelId,
          workspace.id,
        );
        return { success: true, labelId: args.labelId };
      }

      case 'list_labels': {
        return this.labelService.getLabels(
          workspace.id,
          user.id,
          LabelType.PAGE,
          this.pagination(args),
        );
      }

      case 'find_pages_by_label': {
        if (args.spaceId) {
          const ability = await this.spaceAbility.createForUser(
            user,
            args.spaceId,
          );
          if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
            throw new ForbiddenException();
          }
        }

        const labelId = await this.resolveLabelId(args, workspace);
        if (!labelId) {
          return { items: [] };
        }

        return this.labelService.findPagesByLabel(labelId, user.id, {
          spaceId: args.spaceId,
          pagination: this.pagination(args),
        });
      }

      // --- favorites ---
      case 'list_favorites': {
        return this.favoriteService.getUserFavorites(
          user.id,
          workspace.id,
          this.pagination(args),
          args.type as FavoriteType | undefined,
          args.spaceId,
        );
      }

      case 'add_favorite': {
        const target = await this.resolveFavoriteTarget(args, user, workspace);

        await this.favoriteService.addFavorite(user.id, workspace.id, {
          type: args.type,
          pageId: args.pageId,
          spaceId: args.type === 'space' ? target.spaceId : undefined,
          templateId: args.templateId,
        });

        return { success: true };
      }

      case 'remove_favorite': {
        await this.resolveFavoriteTarget(args, user, workspace);

        await this.favoriteService.removeFavorite(user.id, {
          type: args.type,
          pageId: args.pageId,
          spaceId: args.spaceId,
          templateId: args.templateId,
        });

        return { success: true };
      }

      // --- history and trash ---
      case 'list_page_history': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanView(page, user);

        return this.pageHistoryService.findHistoryByPageId(
          page.id,
          this.pagination(args),
        );
      }

      case 'get_page_version': {
        const history = await this.pageHistoryService.findById(args.historyId);
        if (!history) {
          throw notFound('error.mcp.page_version_not_found');
        }

        const page = await this.getPageInWorkspace(history.pageId, workspace);
        await this.pageAccessService.validateCanView(page, user);

        const format = args.format || 'markdown';

        return {
          ...history,
          format,
          content: this.renderPageContent(history.content, format),
        };
      }

      case 'list_trash': {
        if (!args.spaceId) {
          throw badRequest('error.common.spaceid_is_required');
        }

        const ability = await this.spaceAbility.createForUser(
          user,
          args.spaceId,
        );
        if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
          throw new ForbiddenException();
        }

        return this.pageService.getDeletedSpacePages(
          args.spaceId,
          user.id,
          this.pagination(args),
        );
      }

      case 'restore_page': {
        // findById without the deletedAt guard: the page is in the trash
        const page = await this.pageRepo.findById(args.pageId);
        if (!page || page.workspaceId !== workspace.id) {
          throw notFound('error.common.page_not_found');
        }

        const ability = await this.spaceAbility.createForUser(
          user,
          page.spaceId,
        );
        if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
          throw new ForbiddenException();
        }
        await this.pageAccessService.validateCanEdit(page, user);

        await this.pageRepo.restorePage(page.id, workspace.id);

        this.auditService.log({
          event: AuditEvent.PAGE_RESTORED,
          resourceType: AuditResource.PAGE,
          resourceId: page.id,
          spaceId: page.spaceId,
          changes: {
            after: {
              title: getPageTitle(page.title),
              spaceId: page.spaceId,
            },
          },
        });

        return { success: true, pageId: page.id };
      }

      // --- page organization ---
      case 'move_page': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);

        const ability = await this.spaceAbility.createForUser(
          user,
          page.spaceId,
        );
        if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
          throw new ForbiddenException();
        }
        await this.pageAccessService.validateCanEdit(page, user);

        if (args.parentPageId && args.parentPageId !== page.parentPageId) {
          const targetParent = await this.getPageInWorkspace(
            args.parentPageId,
            workspace,
          );
          await this.pageAccessService.validateCanEdit(targetParent, user);
        }

        await this.pageService.movePage(
          {
            pageId: page.id,
            position: args.position,
            parentPageId: args.parentPageId,
          },
          page,
        );

        return { success: true, pageId: page.id };
      }

      case 'move_page_to_space': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);

        if (page.spaceId === args.spaceId) {
          throw badRequest('error.mcp.page_is_already_in_this_space');
        }

        const abilities = await Promise.all([
          this.spaceAbility.createForUser(user, page.spaceId),
          this.spaceAbility.createForUser(user, args.spaceId),
        ]);
        if (
          abilities.some((ability) =>
            ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
          )
        ) {
          throw new ForbiddenException();
        }
        await this.pageAccessService.validateCanEdit(page, user);

        const { childPageIds } = await this.pageService.movePageToSpace(
          page,
          args.spaceId,
          user.id,
        );

        this.auditService.log({
          event: AuditEvent.PAGE_MOVED_TO_SPACE,
          resourceType: AuditResource.PAGE,
          resourceId: page.id,
          spaceId: page.spaceId,
          changes: {
            before: { spaceId: page.spaceId },
            after: { spaceId: args.spaceId },
          },
          metadata: {
            title: getPageTitle(page.title),
            ...(childPageIds.length > 0 && { childPageIds }),
          },
        });

        return { success: true, pageId: page.id, leftBehind: childPageIds };
      }

      case 'duplicate_page': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanView(page, user);

        const targetSpaceId = args.spaceId;
        const spaceIdsToCheck = targetSpaceId
          ? [page.spaceId, targetSpaceId]
          : [page.spaceId];

        const abilities = await Promise.all(
          spaceIdsToCheck.map((spaceId) =>
            this.spaceAbility.createForUser(user, spaceId),
          ),
        );
        if (
          abilities.some((ability) =>
            ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
          )
        ) {
          throw new ForbiddenException();
        }

        const result = await this.pageService.duplicatePage(
          page,
          targetSpaceId,
          user,
        );

        this.auditService.log({
          event: AuditEvent.PAGE_DUPLICATED,
          resourceType: AuditResource.PAGE,
          resourceId: result.id,
          spaceId: targetSpaceId || page.spaceId,
          metadata: {
            sourcePageId: page.id,
            title: getPageTitle(page.title),
            ...(result.childPageIds.length > 0 && {
              childPageIds: result.childPageIds,
            }),
          },
        });

        return result;
      }

      case 'get_page_breadcrumbs': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanView(page, user);

        return {
          breadcrumbs: await this.pageService.getPageBreadCrumbs(page.id),
        };
      }

      case 'get_page_backlinks': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanView(page, user);

        return this.backlinkService.findByPageId(
          page.id,
          args.direction === 'outgoing' ? 'outgoing' : 'incoming',
          user.id,
          this.pagination(args),
        );
      }

      case 'list_recent_pages': {
        if (args.spaceId) {
          const ability = await this.spaceAbility.createForUser(
            user,
            args.spaceId,
          );
          if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
            throw new ForbiddenException();
          }

          return this.pageService.getRecentSpacePages(
            args.spaceId,
            user.id,
            this.pagination(args),
          );
        }

        return this.pageService.getRecentPages(user.id, this.pagination(args));
      }

      // --- templates ---
      case 'list_templates': {
        return this.templateService.listTemplates(
          { ...this.pagination(args), spaceId: args.spaceId },
          user,
          workspace,
        );
      }

      case 'get_template': {
        return this.templateService.getTemplate(
          args.templateId,
          user,
          workspace,
        );
      }

      case 'create_template': {
        return this.templateService.createTemplate(
          {
            title: args.title,
            description: args.description,
            icon: args.icon,
            content: args.content
              ? await this.markdownToProsemirror(args.content)
              : undefined,
            spaceId: args.spaceId,
          },
          user,
          workspace,
        );
      }

      case 'update_template': {
        return this.templateService.updateTemplate(
          {
            templateId: args.templateId,
            title: args.title,
            description: args.description,
            icon: args.icon,
            content: args.content
              ? await this.markdownToProsemirror(args.content)
              : undefined,
          },
          user,
          workspace,
        );
      }

      case 'delete_template': {
        await this.templateService.deleteTemplate(
          args.templateId,
          user,
          workspace,
        );
        return { success: true, templateId: args.templateId };
      }

      case 'use_template': {
        return this.templateService.useTemplate(
          {
            templateId: args.templateId,
            spaceId: args.spaceId,
            parentPageId: args.parentPageId,
          },
          user,
          workspace,
        );
      }

      // --- attachments and export ---
      case 'search_attachments': {
        if (!args.query) {
          throw badRequest('error.mcp.query_is_required');
        }

        if (args.spaceId) {
          const ability = await this.spaceAbility.createForUser(
            user,
            args.spaceId,
          );
          if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
            throw new ForbiddenException();
          }
        }

        // The attachment search itself is not space-scoped, so filter here.
        const { items } = await this.searchAttachmentsService.search(
          args.query,
          workspace.id,
          user.id,
          args.spaceId,
        );

        const spaceIds = new Set(
          await this.spaceMemberRepo.getUserSpaceIds(user.id),
        );
        const inUserSpaces = items.filter((item: any) =>
          spaceIds.has(item.spaceId),
        );

        const accessiblePageIds = new Set(
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds: [
              ...new Set(inUserSpaces.map((item: any) => item.pageId)),
            ] as string[],
            userId: user.id,
            spaceId: args.spaceId,
          }),
        );

        return {
          items: inUserSpaces.filter((item: any) =>
            accessiblePageIds.has(item.pageId),
          ),
        };
      }

      case 'get_attachment_info': {
        const attachment = await this.attachmentRepo.findById(
          args.attachmentId,
        );
        if (
          !attachment ||
          !attachment.pageId ||
          attachment.workspaceId !== workspace.id
        ) {
          throw notFound('error.mcp.file_not_found');
        }

        const page = await this.getPageInWorkspace(
          attachment.pageId,
          workspace,
        );
        await this.pageAccessService.validateCanView(page, user);

        return attachment;
      }

      case 'upload_attachment': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanEdit(page, user);

        const buffer = this.decodeBase64Upload(args.contentBase64);
        const fileName = String(args.fileName || '').trim();
        if (!fileName || !fileName.includes('.')) {
          throw badRequest('error.mcp.filename_must_include_an_extension_e');
        }

        // prepareFile is called with skipBuffer, so it only reads `filename`,
        // and uploadFile consumes `file` as a stream. A Readable over the
        // decoded bytes satisfies both without touching attachment.service.
        const multipartLike = {
          filename: fileName,
          file: Readable.from(buffer),
        } as unknown as MultipartFile;

        const attachment = await this.attachmentService.uploadFile({
          filePromise: Promise.resolve(multipartLike),
          pageId: page.id,
          spaceId: page.spaceId,
          userId: user.id,
          workspaceId: workspace.id,
        });

        if (!attachment) {
          throw badRequest('error.mcp.error_processing_file_upload');
        }

        this.auditService.log({
          event: AuditEvent.ATTACHMENT_UPLOADED,
          resourceType: AuditResource.ATTACHMENT,
          resourceId: attachment.id,
          spaceId: page.spaceId,
          metadata: {
            fileName: attachment.fileName,
            pageId: page.id,
            spaceId: page.spaceId,
          },
        });

        return {
          success: true,
          attachmentId: attachment.id,
          fileName: attachment.fileName,
          fileSize: attachment.fileSize,
          mimeType: attachment.mimeType,
          url: `/api/files/${attachment.id}/${attachment.fileName}`,
        };
      }

      case 'export_page': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanView(page, user);

        const format = (args.format || 'markdown') as ExportFormat;

        const result = await this.exportService.exportPages(
          page.id,
          format,
          false,
          false,
          user.id,
        );

        this.auditService.log({
          event: AuditEvent.PAGE_EXPORTED,
          resourceType: AuditResource.PAGE,
          resourceId: page.id,
          spaceId: page.spaceId,
          metadata: {
            title: getPageTitle(page.title),
            format,
            includeChildren: false,
            includeAttachments: false,
            spaceId: page.spaceId,
          },
        });

        if (result.type !== 'file') {
          throw badRequest('error.mcp.this_export_produced_an_archive_which');
        }

        return result.content;
      }

      default:
        throw badRequest('error.mcp.unknown_tool', { tool: name });
    }
  }

  /**
   * Base64 travels through the model context, so the ceiling here is about
   * what is sane to put in a prompt, not what the server could store.
   */
  private decodeBase64Upload(input: unknown): Buffer {
    if (typeof input !== 'string' || input.trim() === '') {
      throw badRequest('error.mcp.contentbase64_is_required');
    }

    // Tolerate a data: URI even though the schema asks for raw base64 —
    // models produce them often enough that rejecting is just friction.
    const payload = input.replace(/^data:[^;]+;base64,/, '').trim();

    if (payload.length > MAX_UPLOAD_BASE64_CHARS) {
      throw badRequest('error.mcp.upload_too_large', {
        limit: MAX_UPLOAD_BYTES / (1024 * 1024),
      });
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(payload, 'base64');
    } catch {
      throw badRequest('error.mcp.contentbase64_is_not_valid_base64');
    }

    // Buffer.from silently drops invalid characters, so an empty result is
    // the only signal that the input was not really base64.
    if (buffer.length === 0) {
      throw badRequest('error.mcp.contentbase64_decoded_to_an_empty_file');
    }

    return buffer;
  }

  private pagination(args: any): PaginationOptions {
    return {
      limit: Math.min(args.limit || 20, 100),
      cursor: args.cursor,
    } as PaginationOptions;
  }

  /** Comment bodies are stored as ProseMirror, but agents write markdown. */
  private async markdownToProsemirror(markdown: string) {
    const html = await markdownToHtml(markdown);
    return htmlToJson(html as string);
  }

  private async markdownToCommentContent(markdown: string): Promise<string> {
    if (typeof markdown !== 'string') {
      throw badRequest('error.mcp.content_must_be_a_markdown_string');
    }
    return JSON.stringify(await this.markdownToProsemirror(markdown));
  }

  private async getCommentInWorkspace(commentId: string, workspace: Workspace) {
    if (!commentId) {
      throw badRequest('error.mcp.commentid_is_required');
    }

    const comment = await this.commentRepo.findById(commentId);
    if (!comment || comment.workspaceId !== workspace.id) {
      throw notFound('error.mcp.comment_not_found');
    }

    const page = await this.getPageInWorkspace(comment.pageId, workspace);
    return { comment, page };
  }

  private async resolveLabelId(
    args: any,
    workspace: Workspace,
  ): Promise<string | null> {
    if (args.labelId) {
      const label = await this.labelRepo.findById(args.labelId);
      if (!label || label.workspaceId !== workspace.id) {
        throw notFound('error.mcp.label_not_found');
      }
      return label.id;
    }

    if (!args.name) {
      throw badRequest('error.mcp.labelid_or_name_is_required');
    }

    const label = await this.labelRepo.findByNameAndWorkspace(
      args.name,
      workspace.id,
      LabelType.PAGE,
    );

    return label?.id ?? null;
  }

  /**
   * Mirrors FavoriteController.resolveAndValidate: a favorite must point at
   * something the user can actually reach.
   */
  private async resolveFavoriteTarget(
    args: any,
    user: User,
    workspace: Workspace,
  ): Promise<{ spaceId: string }> {
    if (args.type === 'page') {
      const page = await this.getPageInWorkspace(args.pageId, workspace);
      await this.pageAccessService.validateCanView(page, user);
      return { spaceId: page.spaceId };
    }

    if (args.type === 'space') {
      if (!args.spaceId) {
        throw badRequest('error.common.spaceid_is_required');
      }
      // createForUser throws when the user is not a member
      await this.spaceAbility.createForUser(user, args.spaceId);
      return { spaceId: args.spaceId };
    }

    if (args.type === 'template') {
      if (!args.templateId) {
        throw badRequest('error.mcp.templateid_is_required');
      }
      const template = await this.templateService.getTemplate(
        args.templateId,
        user,
        workspace,
      );
      return { spaceId: template.spaceId };
    }

    throw badRequest('error.mcp.invalid_favorite_type');
  }

  private async callBaseTool(
    name: string,
    args: any,
    user: User,
    workspace: Workspace,
  ) {
    switch (name) {
      case 'search_everything': {
        return this.searchEverything(args, user, workspace);
      }

      case 'search_semantic': {
        if (!args.query) {
          throw badRequest('error.mcp.query_is_required');
        }

        if (args.spaceId) {
          const ability = await this.spaceAbility.createForUser(
            user,
            args.spaceId,
          );
          if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
            throw new ForbiddenException();
          }
        }

        const spaceIds = args.spaceId
          ? [args.spaceId]
          : await this.spaceMemberRepo.getUserSpaceIds(user.id);

        const limit = Math.min(args.limit || 10, 50);
        const minSimilarity =
          typeof args.minSimilarity === 'number' ? args.minSimilarity : 0.2;

        const hits = await this.embeddingService.search({
          query: args.query,
          workspaceId: workspace.id,
          userId: user.id,
          spaceIds,
          limit,
        });

        const results = hits
          .filter((hit) => hit.similarity >= minSimilarity)
          .slice(0, limit);

        if (results.length === 0) {
          const indexed = await this.embeddingService.countIndexedPages(
            workspace.id,
          );
          if (indexed === 0) {
            return {
              results: [],
              note: 'No page has been embedded yet — run reindex_embeddings first.',
            };
          }
        }

        return { results };
      }

      case 'reindex_embeddings': {
        if (!(await this.embeddingService.isConfigured(workspace.id))) {
          throw badRequest('error.mcp.semantic_search_needs_an_embedding_api');
        }

        const batchSize = Math.min(args.batchSize || 25, 100);
        const pageIds = await this.embeddingService.findUnindexedPageIds(
          workspace.id,
          batchSize,
        );

        let indexed = 0;
        let skipped = 0;
        const failures: string[] = [];

        for (const pageId of pageIds) {
          try {
            const { chunks } = await this.embeddingService.indexPage(pageId);
            if (chunks > 0) indexed++;
            else skipped++;
          } catch (err: any) {
            failures.push(`${pageId}: ${err?.message ?? err}`);
          }
        }

        const stillPending = await this.embeddingService.findUnindexedPageIds(
          workspace.id,
          1000,
        );

        return {
          indexed,
          // Pages with no body text have nothing to embed and stay pending
          // forever; reported separately so the count is not mistaken for a bug.
          skippedEmpty: skipped,
          pendingAfter: stillPending.length,
          totalPagesIndexed: await this.embeddingService.countIndexedPages(
            workspace.id,
          ),
          ...(failures.length > 0 && { failures }),
        };
      }

      case 'create_base': {
        const spaceId = await this.resolveBaseSpaceId(args, workspace, user);

        return this.baseService.createBase(
          {
            name: args.name,
            spaceId,
            parentPageId: args.parentPageId,
            template: args.template || 'table',
          },
          user.id,
          workspace.id,
        );
      }

      case 'list_bases': {
        if (!args.spaceId) {
          throw badRequest('error.common.spaceid_is_required');
        }

        const ability = await this.spaceAbility.createForUser(
          user,
          args.spaceId,
        );
        if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
          throw new ForbiddenException();
        }

        // listBases сам отсеивает базы, закрытые ограничениями страницы.
        return this.baseService.listBases(args.spaceId, workspace.id, user.id);
      }

      case 'get_base': {
        const base = await this.assertCanViewBase(args.pageId, user, workspace);
        return this.baseService.getBaseInfo(base.id, workspace.id);
      }

      case 'update_base': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        return this.baseService.updateBase(
          { pageId: base.id, name: args.name },
          workspace.id,
        );
      }

      case 'delete_base': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        await this.baseService.deleteBase(base.id, user.id, workspace.id);

        this.auditService.log({
          event: AuditEvent.PAGE_TRASHED,
          resourceType: AuditResource.PAGE,
          resourceId: base.id,
          spaceId: base.spaceId,
          changes: {
            before: {
              pageId: base.id,
              slugId: base.slugId,
              title: getPageTitle(base.title),
              spaceId: base.spaceId,
            },
          },
        });

        return { success: true, message: 'Base moved to trash' };
      }

      case 'convert_page_to_base': {
        const page = await this.getPageInWorkspace(args.pageId, workspace);
        await this.pageAccessService.validateCanEdit(page, user);

        return this.baseService.convertPageToBase(
          page.id,
          args.template,
          user.id,
          workspace.id,
        );
      }

      case 'export_base_csv': {
        const base = await this.assertCanViewBase(args.pageId, user, workspace);
        return this.baseService.exportToCsv(base.id, workspace.id);
      }

      case 'create_base_property': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        this.assertJsonObject(args.typeOptions, 'typeOptions');
        return this.baseService.createProperty(
          {
            pageId: base.id,
            name: args.name,
            type: args.type,
            typeOptions: args.typeOptions,
          },
          workspace.id,
        );
      }

      case 'update_base_property': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        this.assertJsonObject(args.typeOptions, 'typeOptions');
        return this.baseService.updateProperty(
          {
            pageId: base.id,
            propertyId: args.propertyId,
            name: args.name,
            type: args.type,
            typeOptions: args.typeOptions,
          },
          workspace.id,
        );
      }

      case 'delete_base_property': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        await this.baseService.deleteProperty(
          args.propertyId,
          base.id,
          workspace.id,
        );
        return { success: true, propertyId: args.propertyId };
      }

      case 'reorder_base_property': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        await this.baseService.reorderProperty(
          args.propertyId,
          base.id,
          args.position,
          workspace.id,
        );
        return { success: true, propertyId: args.propertyId };
      }

      case 'create_base_row': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        this.assertJsonObject(args.cells, 'cells');
        return this.baseService.createRow(
          { pageId: base.id, cells: args.cells },
          user.id,
          workspace.id,
        );
      }

      case 'get_base_row': {
        const base = await this.assertCanViewBase(args.pageId, user, workspace);
        return this.baseService.getRowInfo(args.rowId, base.id, workspace.id);
      }

      case 'list_base_rows': {
        const base = await this.assertCanViewBase(args.pageId, user, workspace);
        return this.baseService.listRows(
          {
            pageId: base.id,
            limit: args.limit,
            cursor: args.cursor,
            filter: args.filter,
          },
          workspace.id,
        );
      }

      case 'update_base_row': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        // updateRow пишет ячейки выражением jsonb_set_many: без объекта
        // драйвер получил бы undefined и упал бы UNDEFINED_VALUE.
        this.assertJsonObject(args.cells, 'cells');
        if (args.cells === undefined || args.cells === null) {
          throw badRequest('error.mcp.cells_required');
        }
        return this.baseService.updateRow(
          { pageId: base.id, rowId: args.rowId, cells: args.cells },
          user.id,
          workspace.id,
        );
      }

      case 'delete_base_row': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        await this.baseService.deleteRow(args.rowId, base.id, workspace.id);
        return { success: true, rowId: args.rowId };
      }

      case 'delete_base_rows': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);

        if (!Array.isArray(args.rowIds) || args.rowIds.length === 0) {
          throw badRequest('error.mcp.rowids_must_be_a_non_empty');
        }

        await this.baseService.deleteRows(args.rowIds, base.id, workspace.id);
        return { success: true, deleted: args.rowIds.length };
      }

      case 'reorder_base_row': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        await this.baseService.reorderRow(
          args.rowId,
          base.id,
          args.position,
          workspace.id,
        );
        return { success: true, rowId: args.rowId };
      }

      case 'list_base_views': {
        const base = await this.assertCanViewBase(args.pageId, user, workspace);
        return {
          views: await this.baseService.listViews(base.id, workspace.id),
        };
      }

      case 'create_base_view': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        this.assertJsonObject(args.config, 'config');
        return this.baseService.createView(
          {
            pageId: base.id,
            name: args.name,
            type: args.type,
            config: args.config,
          },
          user.id,
          workspace.id,
        );
      }

      case 'update_base_view': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        this.assertJsonObject(args.config, 'config');
        return this.baseService.updateView(
          {
            pageId: base.id,
            viewId: args.viewId,
            name: args.name,
            type: args.type,
            config: args.config,
          },
          workspace.id,
        );
      }

      case 'delete_base_view': {
        const base = await this.assertCanEditBase(args.pageId, user, workspace);
        await this.baseService.deleteView(args.viewId, base.id, workspace.id);
        return { success: true, viewId: args.viewId };
      }

      default:
        return this.callWorkspaceTool(name, args, user, workspace);
    }
  }

  /**
   * One keyword, every corner of the workspace.
   *
   * Pages and attachments go through the Postgres full-text index. Base rows
   * and comments have no usable index for this (base rows have no tsv column
   * at all), so they fall back to a substring match over the accessible set —
   * unranked, but it beats being invisible.
   */
  private async searchEverything(args: any, user: User, workspace: Workspace) {
    if (!args.query) {
      throw badRequest('error.mcp.query_is_required');
    }

    const limit = Math.min(args.limitPerType || 10, 50);

    if (args.spaceId) {
      const ability = await this.spaceAbility.createForUser(user, args.spaceId);
      if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    const spaceIds = args.spaceId
      ? [args.spaceId]
      : await this.spaceMemberRepo.getUserSpaceIds(user.id);

    if (spaceIds.length === 0) {
      return {
        query: args.query,
        pages: [],
        rows: [],
        comments: [],
        files: [],
      };
    }

    // A failure in one category should not sink the whole sweep — the agent
    // is better served by partial results plus a note than by an error.
    const [pages, rows, comments, files] = await Promise.all([
      this.sweepPages(args.query, args.spaceId, limit, user, workspace),
      this.sweepBaseRows(args.query, spaceIds, limit, user, workspace),
      this.sweepComments(args.query, spaceIds, limit, user, workspace),
      this.sweepAttachments(
        args.query,
        args.spaceId,
        spaceIds,
        limit,
        user,
        workspace,
      ),
    ]);

    const failed = [
      ['pages', pages],
      ['rows', rows],
      ['comments', comments],
      ['files', files],
    ]
      .filter(([, r]: any) => r.error)
      .map(([name, r]: any) => `${name}: ${r.error}`);

    return {
      query: args.query,
      pages: pages.items,
      rows: rows.items,
      comments: comments.items,
      files: files.items,
      ...(failed.length > 0 && { partialFailures: failed }),
    };
  }

  private async sweep<T>(
    run: () => Promise<T[]>,
  ): Promise<{ items: T[]; error?: string }> {
    try {
      return { items: await run() };
    } catch (err: any) {
      return { items: [], error: err?.message || 'unknown error' };
    }
  }

  private sweepPages(
    query: string,
    spaceId: string | undefined,
    limit: number,
    user: User,
    workspace: Workspace,
  ) {
    return this.sweep(async () => {
      const { items } = await this.searchService.searchPage(
        { query, spaceId, limit } as SearchDTO,
        { userId: user.id, workspaceId: workspace.id },
      );
      return items.map((item: any) => ({
        pageId: item.id,
        slugId: item.slugId,
        title: item.title,
        spaceName: item.space?.name,
        highlight: item.highlight,
      }));
    });
  }

  private sweepBaseRows(
    query: string,
    spaceIds: string[],
    limit: number,
    user: User,
    workspace: Workspace,
  ) {
    return this.sweep(async () => {
      // cells is jsonb keyed by property id; casting to text lets one ILIKE
      // cover every column of every row without knowing the schema.
      const rows = await this.db
        .selectFrom('baseRows')
        .innerJoin('pages', 'pages.id', 'baseRows.pageId')
        .select([
          'baseRows.id as rowId',
          'baseRows.pageId',
          'baseRows.cells',
          'pages.title as baseName',
          'pages.spaceId',
        ])
        .where('baseRows.workspaceId', '=', workspace.id)
        .where('baseRows.deletedAt', 'is', null)
        .where('pages.deletedAt', 'is', null)
        .where('pages.spaceId', 'in', spaceIds)
        .where(sql<boolean>`base_rows.cells::text ILIKE ${'%' + query + '%'}`)
        .limit(limit * 3)
        .execute();

      if (rows.length === 0) return [];

      const accessible = new Set(
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: [...new Set(rows.map((r) => r.pageId))],
          userId: user.id,
        }),
      );

      return rows
        .filter((r) => accessible.has(r.pageId))
        .slice(0, limit)
        .map((r) => {
          const cells =
            typeof r.cells === 'string' ? JSON.parse(r.cells) : r.cells || {};
          return {
            rowId: r.rowId,
            basePageId: r.pageId,
            baseName: r.baseName,
            spaceId: r.spaceId,
            // Only the cells that actually matched, so the agent is not handed
            // the whole record just to find the hit.
            matchedCells: Object.fromEntries(
              Object.entries(cells).filter(([, v]) =>
                String(v).toLowerCase().includes(query.toLowerCase()),
              ),
            ),
          };
        });
    });
  }

  private sweepComments(
    query: string,
    spaceIds: string[],
    limit: number,
    user: User,
    workspace: Workspace,
  ) {
    return this.sweep(async () => {
      const comments = await this.db
        .selectFrom('comments')
        .innerJoin('pages', 'pages.id', 'comments.pageId')
        .select([
          'comments.id as commentId',
          'comments.pageId',
          'comments.content',
          'comments.creatorId',
          'comments.createdAt',
          'pages.title as pageTitle',
          'pages.slugId as pageSlugId',
        ])
        .where('comments.workspaceId', '=', workspace.id)
        .where('comments.deletedAt', 'is', null)
        .where('pages.deletedAt', 'is', null)
        .where('pages.spaceId', 'in', spaceIds)
        .where(sql<boolean>`comments.content::text ILIKE ${'%' + query + '%'}`)
        .orderBy('comments.createdAt', 'desc')
        .limit(limit * 3)
        .execute();

      if (comments.length === 0) return [];

      const accessible = new Set(
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: [...new Set(comments.map((c) => c.pageId))],
          userId: user.id,
        }),
      );

      return comments
        .filter((c) => accessible.has(c.pageId))
        .slice(0, limit)
        .map((c) => ({
          commentId: c.commentId,
          pageId: c.pageId,
          pageTitle: c.pageTitle,
          pageSlugId: c.pageSlugId,
          creatorId: c.creatorId,
          createdAt: c.createdAt,
          excerpt: jsonToText(c.content as any).slice(0, 300),
        }));
    });
  }

  private sweepAttachments(
    query: string,
    spaceId: string | undefined,
    spaceIds: string[],
    limit: number,
    user: User,
    workspace: Workspace,
  ) {
    return this.sweep(async () => {
      const { items } = await this.searchAttachmentsService.search(
        query,
        workspace.id,
        user.id,
        spaceId,
      );

      const allowedSpaces = new Set(spaceIds);
      const inScope = items.filter((item: any) =>
        allowedSpaces.has(item.spaceId),
      );
      if (inScope.length === 0) return [];

      const accessible = new Set(
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds: [...new Set(inScope.map((i: any) => i.pageId))] as string[],
          userId: user.id,
        }),
      );

      return inScope
        .filter((item: any) => accessible.has(item.pageId))
        .slice(0, limit);
    });
  }

  /**
   * A base is a page, so base access is page access. Resolving through
   * getPageInWorkspace also lets the agent pass a slugId instead of a UUID.
   */
  private async assertCanViewBase(
    pageId: string,
    user: User,
    workspace: Workspace,
  ): Promise<Page> {
    const page = await this.getPageInWorkspace(pageId, workspace);

    if (!page.isBase) {
      throw notFound('error.common.base_not_found');
    }

    await this.pageAccessService.validateCanView(page, user);
    return page;
  }

  private async assertCanEditBase(
    pageId: string,
    user: User,
    workspace: Workspace,
  ): Promise<Page> {
    const page = await this.getPageInWorkspace(pageId, workspace);

    if (!page.isBase) {
      throw notFound('error.common.base_not_found');
    }

    await this.pageAccessService.validateCanEdit(page, user);
    return page;
  }

  /**
   * Drop pages the user cannot reach because of page-level restrictions.
   * Space membership alone is not enough — a page (or an ancestor) can be
   * restricted to a subset of the space members.
   */
  /**
   * Проверить, что аргумент это объект.
   *
   * Аргументы инструментов MCP приходят без валидации, а колонки base
   * ограничены `jsonb_typeof(...) = 'object'`. Без этой проверки строка или
   * массив доходят до базы, и агент получает дословный текст ошибки Postgres
   * с именем ограничения вместо объяснения, что он передал не то.
   */
  private assertJsonObject(value: unknown, argument: string): void {
    if (value === undefined || value === null) return;
    if (
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value instanceof Date
    ) {
      throw badRequest('error.mcp.argument_must_be_object', { argument });
    }
  }

  private async filterRestrictedPages<T extends { id: string }>(
    pages: T[],
    user: User,
    spaceId?: string,
  ): Promise<T[]> {
    if (pages.length === 0) return pages;

    const accessibleIds = await this.pagePermissionRepo.filterAccessiblePageIds(
      {
        pageIds: pages.map((page) => page.id),
        userId: user.id,
        spaceId,
      },
    );

    const accessible = new Set(accessibleIds);
    return pages.filter((page) => accessible.has(page.id));
  }

  /**
   * createBase derives the space from the parent page when spaceId is omitted.
   * Resolve it here first so the permission check runs against the real target.
   */
  private async resolveBaseSpaceId(
    args: any,
    workspace: Workspace,
    user: User,
  ): Promise<string> {
    if (args.parentPageId) {
      const parentPage = await this.getPageInWorkspace(
        args.parentPageId,
        workspace,
      );

      if (args.spaceId && parentPage.spaceId !== args.spaceId) {
        throw badRequest('error.mcp.parentpageid_does_not_belong_to_the');
      }

      await this.pageAccessService.validateCanEdit(parentPage, user);
      return parentPage.spaceId;
    }

    if (!args.spaceId) {
      throw badRequest('error.common.spaceid_or_parentpageid_is_required');
    }

    await this.assertCanCreateInSpace(user, args.spaceId);
    return args.spaceId;
  }
}
