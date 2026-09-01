"""Журнал аудита.

Запись о том, кто что сделал, и её чтение администратором пространства.

**Пишется прямо, а не через очередь. Это осознанное расхождение с v1.** Там
запись идёт заданием, и в комментарии сказано прямо: потеря отдельных событий
при сбое Redis принята как плата за то, чтобы не утяжелять горячие пути.
Здесь запись выполняется в той же транзакции, что и само действие, и это лучше
по двум причинам сразу. Событие не может остаться без действия, а действие без
события: откат уносит обе записи. И событие не теряется от того, что Redis
оказался недоступен.

Цена — одна вставка на действие. Она приемлема, потому что здесь аудит не стоит
на чтении страницы: в v1 он стоит и там, и именно это сделало очередь
необходимой. Если событие просмотра появится, решение придётся пересмотреть, и
пересматривать его надо с замером, а не по памяти.

**В `changes` кладутся только имена изменённых полей, а не значения.** Журнал
читает администратор пространства, которому сама страница может быть закрыта:
значения превратили бы журнал в обходной путь к содержимому.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden
from tessera_api.domain.roles import is_workspace_admin
from tessera_api.infrastructure.models import AuditLog, User, Workspace


class AuditEvent:
    """Имена событий. Совпадают с v1: журнал общий, читается одними глазами."""

    USER_LOGGED_IN = "user.logged_in"
    USER_LOGGED_OUT = "user.logged_out"
    USER_PASSWORD_CHANGED = "user.password_changed"
    USER_ROLE_CHANGED = "user.role_changed"
    USER_DEACTIVATED = "user.deactivated"
    USER_ACTIVATED = "user.activated"
    USER_DELETED = "user.deleted"
    USER_INVITE_ACCEPTED = "user.invite_accepted"
    USER_INVITED = "user.invited"
    WORKSPACE_INVITE_RESENT = "workspace.invite_resent"
    WORKSPACE_CREATED = "workspace.created"
    WORKSPACE_UPDATED = "workspace.updated"
    SPACE_CREATED = "space.created"
    SPACE_UPDATED = "space.updated"
    SPACE_DELETED = "space.deleted"
    SPACE_MEMBER_ADDED = "space.member_added"
    SPACE_MEMBER_REMOVED = "space.member_removed"
    SPACE_MEMBER_ROLE_CHANGED = "space.member_role_changed"
    GROUP_CREATED = "group.created"
    GROUP_UPDATED = "group.updated"
    GROUP_DELETED = "group.deleted"
    GROUP_MEMBER_ADDED = "group.member_added"
    GROUP_MEMBER_REMOVED = "group.member_removed"
    MFA_ENABLED = "mfa.enabled"
    MFA_DISABLED = "mfa.disabled"
    MFA_RESET = "mfa.reset"
    API_KEY_CREATED = "api_key.created"
    API_KEY_UPDATED = "api_key.updated"
    API_KEY_DELETED = "api_key.deleted"
    SCIM_TOKEN_CREATED = "scim_token.created"
    SCIM_TOKEN_UPDATED = "scim_token.updated"
    SCIM_TOKEN_DELETED = "scim_token.deleted"
    SSO_PROVIDER_CREATED = "sso.provider_created"
    SSO_PROVIDER_UPDATED = "sso.provider_updated"
    SSO_PROVIDER_DELETED = "sso.provider_deleted"
    USER_SSO_UNLINKED = "user.sso_unlinked"
    PAGE_IMPORTED = "page.imported"
    PAGE_EXPORTED = "page.exported"
    SPACE_EXPORTED = "space.exported"


class AuditResource:
    USER = "user"
    WORKSPACE = "workspace"
    SPACE = "space"
    GROUP = "group"
    PAGE = "page"
    API_KEY = "api_key"
    MFA = "mfa"
    WORKSPACE_INVITATION = "workspace_invitation"
    SSO_PROVIDER = "sso_provider"
    SCIM_TOKEN = "scim_token"


class ActorType:
    """Кто совершил действие.

    Без этого различения действия синхронизации каталога неотличимы от действий
    администратора, и вопрос «кто снял человека с доступа» остаётся без ответа.
    """

    USER = "user"
    #: Само приложение: периодические задачи, миграции состояния.
    SYSTEM = "system"
    #: Ключ API. Человек за ним есть, но действовал не он лично.
    API_KEY = "api_key"


#: Верхняя граница срока хранения, десять лет. Отсекает опечатку с лишним
#: нулём: журнал за сто лет никому не нужен, а место занимает.
MAX_RETENTION_DAYS = 3650

#: Сколько записей отдавать за раз, если не сказано иное.
DEFAULT_LIMIT = 20
MAX_LIMIT = 100


def changed_fields(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any] | None:
    """Имена полей, которые изменились. Без значений.

    Пустое изменение даёт `None`, а не `{"fields": []}`: пустой список в журнале
    читается как «что-то поменяли, но неизвестно что», и это хуже отсутствия
    записи о полях.
    """
    fields = sorted(
        key for key in set(before) | set(after) if before.get(key) != after.get(key)
    )
    return {"fields": fields} if fields else None


@dataclass(frozen=True, slots=True)
class AuditPage:
    """Страница журнала и курсор для следующей."""

    items: list[dict]
    next_cursor: str | None


class AuditService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def log(
        self,
        *,
        event: str,
        resource_type: str,
        resource_id: uuid.UUID | None,
        user_id: uuid.UUID | None,
        workspace_id: uuid.UUID,
        changes: dict[str, Any] | None = None,
        ip: str | None = None,
        space_id: uuid.UUID | None = None,
        actor_type: str = ActorType.USER,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Записать событие.

        Отказ записи не отменяет самого действия: журнал важен, но человек уже
        сменил пароль, и откатывать это из-за журнала неверно. При этом
        молчаливым отказ быть не должен, поэтому он всплывает наружу и
        обрабатывается вызывающим, а не глушится здесь.

        Автор передаётся явно, а не берётся из контекста запроса. На открытых
        маршрутах — вход, принятие приглашения, вход через провайдера — его в
        контексте ещё нет, и событие ушло бы без автора именно там, где он
        важнее всего.
        """
        await self._session.execute(
            insert(AuditLog).values(
                id=uuid.uuid4(),
                event=event,
                resource_type=resource_type,
                resource_id=resource_id,
                actor_id=user_id,
                actor_type=actor_type,
                workspace_id=workspace_id,
                space_id=space_id,
                changes=changes,
                event_metadata=metadata,
                ip_address=ip,
            )
        )

    # --- чтение -----------------------------------------------------------

    def _assert_can_read(self, actor: User) -> None:
        """Журнал читает администратор пространства.

        Обычному участнику он не полагается: по нему видно, кто когда входил и
        что открывал, то есть распорядок работы каждого сотрудника.
        """
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

    async def list(
        self,
        actor: User,
        workspace_id: uuid.UUID,
        *,
        event: str | None = None,
        resource_type: str | None = None,
        actor_id: uuid.UUID | None = None,
        space_id: uuid.UUID | None = None,
        start: datetime | None = None,
        end: datetime | None = None,
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> AuditPage:
        """Страница журнала, от свежих к старым.

        Постраничность курсорная, а не по смещению. Журнал пополняется во время
        просмотра, и смещение при этом сдвигает окно: часть записей
        показывается дважды, часть не показывается вовсе.

        Курсор составной, `момент|идентификатор`. Одного момента мало: события
        пакетного действия попадают в одну миллисекунду, и курсор по одному
        только моменту либо повторял бы их, либо пропускал.
        """
        self._assert_can_read(actor)

        limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))

        stmt = select(AuditLog).where(AuditLog.workspace_id == workspace_id)
        if event:
            stmt = stmt.where(AuditLog.event == event)
        if resource_type:
            stmt = stmt.where(AuditLog.resource_type == resource_type)
        if actor_id is not None:
            stmt = stmt.where(AuditLog.actor_id == actor_id)
        if space_id is not None:
            stmt = stmt.where(AuditLog.space_id == space_id)
        if start is not None:
            stmt = stmt.where(AuditLog.created_at >= start)
        if end is not None:
            stmt = stmt.where(AuditLog.created_at <= end)

        after = _decode_cursor(cursor)
        if after is not None:
            moment, last_id = after
            # Кортежное сравнение, а не два условия через ИЛИ: оно и короче, и
            # совпадает с порядком сортировки, поэтому индекс по паре работает.
            stmt = stmt.where(
                text("(audit.created_at, audit.id) < (:cursor_at, :cursor_id)").bindparams(
                    cursor_at=moment, cursor_id=last_id
                )
            )

        stmt = stmt.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit + 1)
        rows = list((await self._session.execute(stmt)).scalars().all())

        # Запрашивается на одну запись больше, чем нужно: так видно, есть ли
        # следующая страница, без второго запроса на счёт.
        has_more = len(rows) > limit
        rows = rows[:limit]

        actors = await self._actors([one.actor_id for one in rows if one.actor_id])
        items = [_view(one, actors.get(one.actor_id)) for one in rows]
        next_cursor = _encode_cursor(rows[-1]) if has_more and rows else None
        return AuditPage(items=items, next_cursor=next_cursor)

    async def _actors(self, ids: list[uuid.UUID]) -> dict[uuid.UUID, User]:
        """Авторы страницы одним запросом.

        Соединением с `users` это делать нельзя: `actor_id` не имеет внешнего
        ключа и указывает в том числе на удалённых. Внутреннее соединение
        потеряло бы такие события целиком, а внешнее усложнило бы выборку ради
        одного поля.
        """
        if not ids:
            return {}
        found = (
            (await self._session.execute(select(User).where(User.id.in_(set(ids)))))
            .scalars()
            .all()
        )
        return {one.id: one for one in found}

    # --- срок хранения ----------------------------------------------------

    async def retention(self, actor: User, workspace_id: uuid.UUID) -> int:
        self._assert_can_read(actor)
        workspace = await self._session.get(Workspace, workspace_id)
        # Пустое значение и ноль означают одно и то же: хранить вечно. Приводим
        # к нулю, чтобы у клиента не появилось третьего состояния.
        return int(getattr(workspace, "audit_retention_days", 0) or 0)

    async def set_retention(self, actor: User, workspace_id: uuid.UUID, days: int) -> int:
        """Задать срок хранения.

        Ноль означает «хранить вечно». Отрицательное значение отвергается: оно
        означало бы удаление ещё не записанного и почти наверняка является
        опечаткой.
        """
        self._assert_can_read(actor)
        if days < 0 or days > MAX_RETENTION_DAYS:
            raise bad_request("error.audit.invalid_retention")

        workspace = await self._session.get(Workspace, workspace_id)
        if workspace is None:
            raise bad_request("error.common.workspace_not_found")
        workspace.audit_retention_days = days

        await self.log(
            event=AuditEvent.WORKSPACE_UPDATED,
            resource_type=AuditResource.WORKSPACE,
            resource_id=workspace_id,
            user_id=actor.id,
            workspace_id=workspace_id,
            changes={"fields": ["auditRetentionDays"]},
        )
        await self._session.commit()
        return days


async def purge_expired(session: AsyncSession) -> int:
    """Удалить записи журнала старше срока хранения пространства.

    Срок у каждого пространства свой, поэтому условие сравнивает возраст записи
    с настройкой её собственного пространства, а не с одним общим порогом.

    Ноль и пустое значение означают «хранить вечно» и отсекаются одним условием
    `> 0`. Разделять их нельзя: пространство, которому срок не задавали ни разу,
    хранит вечно ровно так же, как то, где ноль поставили руками.
    """
    result = await session.execute(
        delete(AuditLog).where(
            AuditLog.id.in_(
                select(AuditLog.id)
                .join(Workspace, Workspace.id == AuditLog.workspace_id)
                .where(Workspace.audit_retention_days.isnot(None))
                .where(Workspace.audit_retention_days > 0)
                .where(
                    text(
                        "audit.created_at < now() - "
                        "(workspaces.audit_retention_days || ' days')::interval"
                    )
                )
            )
        )
    )
    return result.rowcount or 0


def _encode_cursor(row: AuditLog) -> str:
    return f"{row.created_at.isoformat()}|{row.id}"


def _decode_cursor(raw: str | None) -> tuple[datetime, uuid.UUID] | None:
    """Разобрать курсор. Негодный молча превращается в его отсутствие.

    Курсор приходит из запроса, и отказ на испорченном значении означал бы
    пятисотый ответ на закладку месячной давности. Первая страница — верный
    ответ на «не понимаю, откуда продолжать».
    """
    if not raw:
        return None
    moment, _, last_id = raw.rpartition("|")
    try:
        parsed = datetime.fromisoformat(moment)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed, uuid.UUID(last_id)
    except (TypeError, ValueError):
        return None


def _view(row: AuditLog, actor: User | None) -> dict:
    """Запись журнала так, как её ждёт экран.

    Имена полей взяты из v1: их разбирает уже написанный клиент.
    """
    return {
        "id": str(row.id),
        "event": row.event,
        "resourceType": row.resource_type,
        "resourceId": str(row.resource_id) if row.resource_id else None,
        "spaceId": str(row.space_id) if row.space_id else None,
        "actorType": row.actor_type,
        "changes": row.changes,
        "metadata": row.event_metadata,
        "ipAddress": row.ip_address,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "actor": (
            {
                "id": str(actor.id),
                "name": actor.name,
                "email": actor.email,
                "avatarUrl": actor.avatar_url,
            }
            if actor is not None
            else None
        ),
    }


__all__ = [
    "MAX_RETENTION_DAYS",
    "ActorType",
    "AuditEvent",
    "AuditPage",
    "AuditResource",
    "AuditService",
    "changed_fields",
    "purge_expired",
]
