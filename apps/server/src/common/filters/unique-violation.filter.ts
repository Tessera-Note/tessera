import {
  ArgumentsHost,
  Catch,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Нарушение уникального ограничения это отказ, а не поломка.
 *
 * Пути создания объекта с уникальным именем читают базу, проверяют занятость,
 * потом вставляют. Между проверкой и вставкой ничего не держится, и при
 * одновременном создании второй запрос доходит до базы и получает 23505.
 * Нест не знает этой ошибки и отдает 500: человек видит поломку там, где по
 * смыслу должно быть «имя занято».
 *
 * Фильтр один на все такие пути, включая будущие. Проверки существования в
 * сервисах остаются: они отвечают за понятное сообщение на обычном пути, а
 * фильтр закрывает только гонку. Приводить сюда всю обработку отказов
 * намеренно не стали, иначе понятные сообщения превратились бы в одно общее.
 */

/** Что именно занято, по имени ограничения. Неизвестное дает общий текст. */
const CONSTRAINT_SUBJECT: Record<string, string> = {
  groups_name_workspace_id_unique: 'A group with this name already exists',
  spaces_slug_workspace_id_unique: 'A space with this slug already exists',
  users_email_workspace_id_unique: 'A user with this email already exists',
  workspaces_hostname_unique: 'This hostname is already taken',
  workspaces_custom_domain_unique: 'This domain is already taken',
  shares_key_workspace_id_unique: 'This share link already exists',
  invitations_email_workspace_id_unique:
    'This email is already invited to the workspace',
  labels_workspace_id_type_name_unique: 'A label with this name already exists',
  page_labels_page_id_label_id_unique: 'This label is already on the page',
  page_verifiers_verification_user_unique:
    'This user is already a verifier of the page',
  page_transclusions_page_transclusion_unique:
    'This synced block already exists on the page',
  page_transclusion_references_unique:
    'This synced block is already referenced here',
  backlinks_source_page_id_target_page_id_unique:
    'This link is already recorded',
  auth_accounts_user_id_auth_provider_id_unique:
    'This user is already linked to the provider',
};

const UNIQUE_VIOLATION = '23505';

type PostgresError = { code?: string; constraint?: string };

@Catch()
export class UniqueViolationFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(UniqueViolationFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const error = exception as PostgresError;

    // Подмена уместна только для HTTP: у сокета и очереди свой способ ответа,
    // и превращать их ошибку в ответ с кодом состояния нечем.
    if (host.getType() !== 'http' || error?.code !== UNIQUE_VIOLATION) {
      super.catch(exception, host);
      return;
    }

    const message =
      CONSTRAINT_SUBJECT[error.constraint ?? ''] ?? 'This record already exists';

    // Имя ограничения остается в журнале: наружу уходит только то, что понятно
    // человеку, а разбирать случившееся по общему тексту невозможно.
    this.logger.warn(
      `Нарушено уникальное ограничение ${error.constraint ?? 'без имени'}`,
    );

    super.catch(new ConflictException(message), host);
  }
}
