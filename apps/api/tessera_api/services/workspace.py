"""Рабочее пространство и его участники."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import UserRole, is_workspace_admin
from tessera_api.infrastructure.models import (
    Attachment,
    AuthAccount,
    AuthProvider,
    Favorite,
    GroupUser,
    SpaceMember,
    User,
    UserSession,
    Watcher,
    Workspace,
)
from tessera_api.infrastructure.storage import Storage, image_key
from tessera_api.services.attachments import TYPE_AVATAR
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
from tessera_api.services.realtime import RealtimeService

logger = logging.getLogger(__name__)

#: Длина имени рабочего пространства. Ограничение из v1: имя стоит в заголовке
#: письма и в боковой панели, и строка на тысячу знаков ломает и то и другое.
MAX_NAME = 64

#: Предел срока хранения корзины. Тот же порядок, что у журнала: десять лет.
MAX_TRASH_DAYS = 3650

#: Настройки, живущие в JSON рабочего пространства. Путь до значения и имя
#: поля запроса. Имена полей из v1: их же понимает уже написанный клиент.
JSON_FLAGS = {
    "disablePublicSharing": ("sharing", "disabled"),
    "restrictApiToAdmins": ("api", "restrictToAdmins"),
    "allowMemberTemplates": ("templates", "allowMemberTemplates"),
    "allowPersonalSpaces": ("spaces", "allowPersonal"),
    # Канал MCP. Путь тот же, что читает `feature_enabled(workspace, "mcp")`:
    # без записи по этому пути канал включить нечем, и маршрут `/api/mcp`
    # отвечает отказом всегда.
    "mcpEnabled": ("ai", "mcp"),
}


class WorkspaceService:
    def __init__(
        self,
        session: AsyncSession,
        realtime: RealtimeService | None = None,
        storage: Storage | None = None,
    ) -> None:
        self._session = session
        self._audit = AuditService(session)
        # `None` означает «канал не трогать»: так собирают службу проверки.
        self._realtime = realtime
        # Нужен удалению участника: вместе с обезличиванием убирается его
        # аватар. `None` означает «хранилище не трогать».
        self._storage = storage

    async def members(self, workspace_id: uuid.UUID, limit: int = 100) -> list[User]:
        stmt = (
            select(User)
            .where(User.workspace_id == workspace_id)
            .where(User.deleted_at.is_(None))
            .order_by(User.created_at.asc())
            .limit(limit)
        )
        return list((await self._session.execute(stmt)).scalars().all())

    async def update(
        self,
        actor: User,
        workspace_id: uuid.UUID,
        *,
        name: str | None = None,
        description: str | None = None,
        trash_retention_days: int | None = None,
        enforce_mfa: bool | None = None,
        enforce_sso: bool | None = None,
        flags: dict[str, bool] | None = None,
    ) -> Workspace:
        """Правка общих настроек рабочего пространства.

        Правит администратор: настройки здесь решают, можно ли отдавать
        страницы наружу, обязателен ли второй фактор и сколько живёт корзина.

        Поле, которого нет в запросе, не трогается. Экран шлёт изменённое, и
        передача пустых значений стирала бы соседние настройки.
        """
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

        workspace = await self._session.get(Workspace, workspace_id)
        if workspace is None:
            raise not_found("error.common.workspace_not_found")

        changed: list[str] = []

        if name is not None:
            clean = name.strip()
            if not clean or len(clean) > MAX_NAME:
                raise bad_request("error.workspace.name_invalid")
            if clean != workspace.name:
                workspace.name = clean
                changed.append("name")

        if description is not None:
            workspace.description = description.strip() or None
            changed.append("description")

        if trash_retention_days is not None:
            # Ноль означал бы удаление корзины сразу после удаления страницы,
            # то есть отмену самой корзины.
            if trash_retention_days < 1 or trash_retention_days > MAX_TRASH_DAYS:
                raise bad_request("error.workspace.invalid_retention")
            if trash_retention_days != workspace.trash_retention_days:
                workspace.trash_retention_days = trash_retention_days
                changed.append("trashRetentionDays")

        if enforce_mfa is not None and bool(workspace.enforce_mfa) != enforce_mfa:
            workspace.enforce_mfa = enforce_mfa
            changed.append("enforceMfa")

        if enforce_sso is not None and bool(workspace.enforce_sso) != enforce_sso:
            if enforce_sso and not await self._has_enabled_provider(workspace_id):
                # Требование входа через провайдера без единого включённого
                # провайдера запирает всех: парольный вход уже закрыт, а
                # другого нет.
                raise bad_request("error.workspace.sso_provider_required")
            workspace.enforce_sso = enforce_sso
            changed.append("enforceSso")

        for field, path in JSON_FLAGS.items():
            value = (flags or {}).get(field)
            if value is None:
                continue
            if self._flag(workspace, path) == bool(value):
                continue
            self._set_flag(workspace, path, bool(value))
            changed.append(field)

        if not changed:
            return workspace

        await self._audit.log(
            event=AuditEvent.WORKSPACE_UPDATED,
            resource_type=AuditResource.WORKSPACE,
            resource_id=workspace_id,
            user_id=actor.id,
            workspace_id=workspace_id,
            changes={"fields": changed},
        )
        await self._session.commit()
        await self._session.refresh(workspace)
        return workspace

    async def _has_enabled_provider(self, workspace_id: uuid.UUID) -> bool:
        found = (
            await self._session.execute(
                select(AuthProvider.id)
                .where(AuthProvider.workspace_id == workspace_id)
                .where(AuthProvider.is_enabled.is_(True))
                .where(AuthProvider.deleted_at.is_(None))
                .limit(1)
            )
        ).first()
        return found is not None

    @staticmethod
    def _flag(workspace: Workspace, path: tuple[str, str]) -> bool:
        settings: object = workspace.settings or {}
        for key in path:
            if not isinstance(settings, dict):
                return False
            settings = settings.get(key)
            if settings is None:
                return False
        return bool(settings)

    @staticmethod
    def _set_flag(workspace: Workspace, path: tuple[str, str], value: bool) -> None:
        """Записать признак в JSON настроек.

        Словарь пересобирается целиком: правка вложенного словаря на месте не
        помечает поле изменённым, и SQLAlchemy такую правку не сохраняет.
        """
        section, field = path
        settings = dict(workspace.settings or {})
        block = dict(settings.get(section) or {})
        block[field] = value
        settings[section] = block
        workspace.settings = settings

    async def _target(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> User:
        found = await self._session.get(User, user_id)
        if found is None or found.workspace_id != workspace_id or found.deleted_at is not None:
            raise not_found("error.common.user_not_found")
        return found

    def _assert_can_manage(self, actor: User, target: User) -> None:
        """Кто над кем властен.

        Два правила из v1, и оба нужны. Администратор не трогает владельца,
        иначе он отбирает пространство у того, кто его завёл. Никто не трогает
        себя: самодеактивация оставляет пространство без администратора, и
        починить это изнутри уже нечем.

        Владельцы при этом равны между собой, и это тоже правило v1. Запрет
        «равный не трогает равного» выглядит осторожнее, но запирает
        пространство: двух владельцев, из которых один ушёл, некому развести —
        удалить друг друга они не могут, а третьего назначить может только
        владелец. Последнего владельца бережёт отдельная проверка, и её
        достаточно.
        """
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")
        if actor.id == target.id:
            raise bad_request("error.workspace.you_cannot_change_yourself")
        if actor.role == UserRole.ADMIN and target.role == UserRole.OWNER:
            raise forbidden("error.workspace.owner_required")

    async def change_role(
        self, actor: User, user_id: uuid.UUID, role: str, workspace_id: uuid.UUID
    ) -> User:
        target = await self._target(user_id, workspace_id)
        self._assert_can_manage(actor, target)

        if role not in tuple(UserRole):
            raise bad_request("error.workspace.unknown_role")

        # Последнего владельца понижать нельзя: пространство осталось бы без
        # владельца, а назначить нового может только он.
        if target.role == UserRole.OWNER and role != UserRole.OWNER:
            owners = await self._count_owners(workspace_id)
            if owners <= 1:
                raise bad_request("error.workspace.last_owner")

        previous = target.role
        await self._session.execute(update(User).where(User.id == user_id).values(role=role))
        await self._audit.log(
            event=AuditEvent.USER_ROLE_CHANGED,
            resource_type=AuditResource.USER,
            resource_id=user_id,
            user_id=actor.id,
            workspace_id=workspace_id,
            changes={"before": {"role": previous}, "after": {"role": role}},
        )
        await self._session.commit()
        return await self._target(user_id, workspace_id)

    async def set_active(
        self, actor: User, user_id: uuid.UUID, active: bool, workspace_id: uuid.UUID
    ) -> User:
        target = await self._target(user_id, workspace_id)
        self._assert_can_manage(actor, target)

        if not active and target.role == UserRole.OWNER:
            owners = await self._count_owners(workspace_id)
            if owners <= 1:
                raise bad_request("error.workspace.last_owner")

        await self._session.execute(
            update(User)
            .where(User.id == user_id)
            .values(deactivated_at=None if active else datetime.now(UTC))
        )

        revoked: list[uuid.UUID] = []
        if not active:
            # Отключение обязано отзывать сессии, а не только закрывать вход.
            # Иначе отключённый продолжает работать по уже выданному токену до
            # конца его срока, то есть отключение выглядит выполненным, не
            # будучи им. Охрана запроса такого человека тоже не пускает, но
            # отозванная сессия — это ещё и разорванное соединение канала.
            revoked = list(
                (
                    await self._session.execute(
                        update(UserSession)
                        .where(UserSession.user_id == user_id)
                        .where(UserSession.workspace_id == workspace_id)
                        .where(UserSession.revoked_at.is_(None))
                        .values(revoked_at=datetime.now(UTC))
                        .returning(UserSession.id)
                    )
                )
                .scalars()
                .all()
            )
        await self._audit.log(
            event=AuditEvent.USER_ACTIVATED if active else AuditEvent.USER_DEACTIVATED,
            resource_type=AuditResource.USER,
            resource_id=user_id,
            user_id=actor.id,
            workspace_id=workspace_id,
        )
        await self._session.commit()
        if revoked and self._realtime is not None:
            await self._realtime.drop_sessions(revoked)
        return await self._target(user_id, workspace_id)

    async def delete_member(
        self, actor: User, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> None:
        """Удалить участника из рабочего пространства.

        Не строка в базе, а обезличивание. Записи ссылаются на человека со всех
        сторон: страницы, правки, комментарии, журнал. Стереть строку значило бы
        либо разорвать эти ссылки, либо унести с собой чужие страницы. Поэтому
        имя и почта заменяются, а сама запись остаётся якорем ссылок.

        Заодно снимается принадлежность: членство в пространствах, состав
        групп, связи с провайдерами входа, подписки и отметки — тот же список,
        что у v1. Отключение закрывает вход, но участник, у которого осталось
        членство, продолжает числиться в списках и получать письма.

        Права на отдельные страницы, ключи API и второй множитель при этом
        остаются, и это не упущение: вход в них всё равно закрыт отметкой
        удаления, которую проверяют и охрана сеанса, и проверка ключа. Удалять
        их значило бы разойтись с v1 на общей базе ради данных, которые уже
        никого не пускают.

        Почта делается заведомо невозможной для входа и при этом уникальной:
        сохранить прежнюю нельзя — по ней человека нашли бы поиском участников,
        а очистить нельзя — уникальность почты в пространстве не даст удалить
        второго.
        """
        target = await self._target(user_id, workspace_id)
        self._assert_can_manage(actor, target)

        # Отдельной проверки «не последний владелец» здесь нет намеренно.
        # Она не может сработать: администратора к владельцу не пускает правило
        # выше, а сам себя никто не удаляет — значит, удаляющий владелец в
        # пространстве всегда второй. Проверка, которая не срабатывает никогда,
        # выглядит как защита, но ничего не защищает.

        before = {"name": target.name, "email": target.email, "role": target.role}
        now = datetime.now(UTC)
        # Адрес аватара запоминается до обезличивания: после него ссылки нет, а
        # файл в хранилище остаётся, и найти его будет нечем — ни отказа, ни
        # записи в журнале.
        avatar = target.avatar_url

        await self._session.execute(
            update(User)
            .where(User.id == user_id)
            .values(
                # Подпись и домен адреса взяты у v1 дословно, и это не
                # косметика. База у двух версий одна: обезличенный в v2 виден в
                # v1 и наоборот, а расхождение дало бы в одном списке участников
                # два разных имени у одинаково удалённых. Сама подпись при этом
                # ещё и ключ словаря — показ переводит её на язык читающего.
                name="Deleted user",
                email=f"{uuid.uuid4()}@deleted.tessera.com",
                avatar_url=None,
                settings=None,
                deleted_at=now,
                # Связь с каталогом снимается вместе с обезличиванием: удержанный
                # удалённой строкой внешний идентификатор не даст завести того же
                # человека заново по синхронизации.
                scim_external_id=None,
            )
        )
        await self._session.execute(delete(GroupUser).where(GroupUser.user_id == user_id))
        await self._session.execute(
            delete(SpaceMember).where(SpaceMember.user_id == user_id)
        )
        await self._session.execute(
            delete(AuthAccount)
            .where(AuthAccount.user_id == user_id)
            .where(AuthAccount.workspace_id == workspace_id)
        )
        await self._session.execute(
            delete(Watcher)
            .where(Watcher.user_id == user_id)
            .where(Watcher.workspace_id == workspace_id)
        )
        await self._session.execute(
            delete(Favorite)
            .where(Favorite.user_id == user_id)
            .where(Favorite.workspace_id == workspace_id)
        )

        revoked = list(
            (
                await self._session.execute(
                    update(UserSession)
                    .where(UserSession.user_id == user_id)
                    .where(UserSession.workspace_id == workspace_id)
                    .where(UserSession.revoked_at.is_(None))
                    .values(revoked_at=now)
                    .returning(UserSession.id)
                )
            )
            .scalars()
            .all()
        )

        await self._audit.log(
            event=AuditEvent.USER_DELETED,
            resource_type=AuditResource.USER,
            resource_id=user_id,
            user_id=actor.id,
            workspace_id=workspace_id,
            changes={"before": before},
        )
        await self._session.commit()

        # Аватар убирается после записи: сначала снята ссылка, потом файл.
        # Обратный порядок при сбое оставил бы ссылку на несуществующий файл,
        # то есть битую картинку вместо прежней.
        await self._forget_avatar(avatar, workspace_id)

        if revoked and self._realtime is not None:
            # Отзыв сессии закрывает вход, но открытое соединение канала живёт
            # само: без разрыва удалённый остаётся на связи.
            await self._realtime.drop_sessions(revoked)

    async def _forget_avatar(self, avatar: str | None, workspace_id: uuid.UUID) -> None:
        """Убрать аватар удалённого участника из хранилища и из учёта.

        Обезличивание снимает ссылку, но файл остаётся: ни отказа, ни записи в
        журнале, а обнаружить его потом не по чему — имя случайное, владельца
        уже нет.

        Внешний адрес пропускается: он не наш, и удалять по нему нечего.
        """
        if not avatar or self._storage is None:
            return
        if avatar.startswith("http://") or avatar.startswith("https://"):
            return

        key = image_key(workspace_id, TYPE_AVATAR, avatar)
        try:
            await self._storage.delete(key)
        except Exception:  # noqa: BLE001 — участник удалён, файл подождёт уборки
            logger.warning("Аватар удалённого участника не убран: %s", key)
            return
        await self._session.execute(delete(Attachment).where(Attachment.file_path == key))
        await self._session.commit()

    async def _count_owners(self, workspace_id: uuid.UUID) -> int:
        stmt = (
            select(User.id)
            .where(User.workspace_id == workspace_id)
            .where(User.role == UserRole.OWNER)
            .where(User.deleted_at.is_(None))
            .where(User.deactivated_at.is_(None))
        )
        return len((await self._session.execute(stmt)).all())
