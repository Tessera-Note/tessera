"""Совместное редактирование: серверная половина.

Само редактирование ведёт сосед на Node (`services/collab`): там протокол
Hocuspocus, состояние Yjs и схема узлов редактора. Сюда он ходит за всем, что
требует базы и прав: кого пускать, что грузить, что сохранять и у кого право
уже отобрали.

Разделение не вкусовое. Схема узлов описана расширениями Tiptap на TypeScript,
и второе её описание не даёт отказа — оно молча теряет узлы при каждом
сохранении. Права и запись в базу описаны здесь, и второго описания у них тоже
быть не должно: сосед не решает, кому что можно, он спрашивает.

**Право проверяется дважды: на подключении и на сохранении.** Между ними
проходят минуты, и за это время человека успевают убрать из пространства.
Проверка только на подключении означала бы, что он допишет страницу, к которой
доступ уже отобран.
"""

from __future__ import annotations

import base64
import logging
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import forbidden, not_found, unauthorized
from tessera_api.infrastructure.models import Page, User
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.services.backlinks import BacklinkService
from tessera_api.services.history import PageHistoryService
from tessera_api.services.notifications import (
    NotificationService,
    NotificationType,
    WatcherService,
)
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.tokens import TokenService, TokenType
from tessera_api.services.transclusion import TransclusionService

if TYPE_CHECKING:
    # Только для подсказок типов: и отправитель писем, и сводка читают отсюда
    # службу уведомлений, и настоящий импорт замкнул бы круг.
    from tessera_api.services.digest import DigestService
    from tessera_api.services.notification_mail import NotificationMailer

logger = logging.getLogger(__name__)

#: Имя документа в протоколе Hocuspocus. Совпадает с v1: `page.<идентификатор>`.
#: Одинаковое имя оставляет возможность сверить две версии на одном документе.
DOCUMENT_PREFIX = "page."


def page_id_of(document_name: str) -> uuid.UUID | None:
    """Идентификатор страницы из имени документа.

    Имя приходит от клиента, поэтому разбор терпимый: негодное имя это отказ
    подключения, а не поломка.
    """
    if not document_name.startswith(DOCUMENT_PREFIX):
        return None
    try:
        return uuid.UUID(document_name[len(DOCUMENT_PREFIX) :])
    except ValueError:
        return None


@dataclass(frozen=True, slots=True)
class CollabRights:
    """Что человеку можно с этим документом."""

    allowed: bool
    can_edit: bool


class CollabService:
    def __init__(
        self,
        session: AsyncSession,
        tokens: TokenService,
        *,
        realtime: RealtimeService | None = None,
        queue: JobQueue | None = None,
        mailer: NotificationMailer | None = None,
        digest: DigestService | None = None,
    ) -> None:
        self._session = session
        self._tokens = tokens
        self._realtime = realtime
        self._queue = queue
        # Письма и сводка. Без них уведомление остаётся только в интерфейсе —
        # это установка без почты, а не поломка.
        self._mailer = mailer
        self._digest = digest
        self._access = PageAccessService(session)

    # --- права ------------------------------------------------------------

    async def rights_for(self, page: Page, user_id: uuid.UUID) -> CollabRights:
        """Правило доступа к документу. Одно на подключение, сохранение и обход.

        Удалённая страница открывается только на чтение: она лежит в корзине,
        её восстанавливают или удаляют насовсем, и правка в этом состоянии
        означала бы правку того, чего для остальных уже нет.
        """
        rights = await self._access.rights(page, user_id)
        if not rights.can_view:
            return CollabRights(allowed=False, can_edit=False)
        if page.deleted_at is not None:
            return CollabRights(allowed=True, can_edit=False)
        return CollabRights(allowed=True, can_edit=rights.can_edit)

    async def _live_user(self, payload_user_id: uuid.UUID, workspace_id: uuid.UUID) -> User:
        """Человек, которому ещё можно работать.

        Токен живёт сутки, и отключение учётной записи его не отзывает. Без
        этой проверки отключённый работает до истечения срока токена.
        """
        found = (
            await self._session.execute(
                select(User)
                .where(User.id == payload_user_id)
                .where(User.workspace_id == workspace_id)
                .where(User.deleted_at.is_(None))
                .where(User.deactivated_at.is_(None))
            )
        ).scalar_one_or_none()
        if found is None:
            raise unauthorized("error.collaboration.invalid_collab_token")
        return found

    async def _page(self, page_id: uuid.UUID, workspace_id: uuid.UUID) -> Page:
        page = await self._session.get(Page, page_id)
        if page is None or page.workspace_id != workspace_id:
            raise not_found("error.page.page_not_found")
        return page

    # --- подключение ------------------------------------------------------

    async def authorize(self, token: str, document_name: str) -> dict:
        """Пустить ли соединение и с каким правом.

        Отдельный вид токена, а не токен доступа: сосед живёт другим процессом,
        и токен доступа, попавший туда, дал бы ему право ходить в приложение от
        имени человека.
        """
        payload = self._tokens.read(token, TokenType.COLLAB)
        if payload is None:
            raise unauthorized("error.collaboration.invalid_collab_token")

        page_id = page_id_of(document_name)
        if page_id is None:
            raise not_found("error.page.page_not_found")

        user = await self._live_user(payload.user_id, payload.workspace_id)
        page = await self._page(page_id, payload.workspace_id)
        rights = await self.rights_for(page, user.id)
        if not rights.allowed:
            raise forbidden("error.page.access_denied")

        return {
            "pageId": str(page.id),
            "workspaceId": str(page.workspace_id),
            "canEdit": rights.can_edit,
            "user": {
                "id": str(user.id),
                "name": user.name,
                "avatarUrl": user.avatar_url,
            },
        }

    async def sweep(self, page_id: uuid.UUID, user_ids: list[uuid.UUID]) -> dict:
        """Права людей, уже сидящих в документе.

        Подключение проверяется один раз, а сеанс длится часами. Без обхода
        человек, которого убрали из пространства, дописывает открытый документ
        до тех пор, пока сам не закроет вкладку.

        Пропавшая страница отзывает всех: её удалили насовсем, и держать над
        ней открытые соединения не над чем.
        """
        page = await self._session.get(Page, page_id)
        if page is None:
            return {"gone": True, "users": {}}

        answer: dict[str, dict] = {}
        for user_id in user_ids:
            live = (
                await self._session.execute(
                    select(User.id)
                    .where(User.id == user_id)
                    .where(User.workspace_id == page.workspace_id)
                    .where(User.deleted_at.is_(None))
                    .where(User.deactivated_at.is_(None))
                )
            ).scalar_one_or_none()
            if live is None:
                answer[str(user_id)] = {"allowed": False, "canEdit": False}
                continue
            rights = await self.rights_for(page, user_id)
            answer[str(user_id)] = {"allowed": rights.allowed, "canEdit": rights.can_edit}
        return {"gone": False, "users": answer}

    # --- содержимое -------------------------------------------------------

    async def load(self, page_id: uuid.UUID) -> dict:
        """Состояние документа для соседа.

        Двоичное состояние отдаётся первым: в нём есть история правок, которой
        в JSON нет, и восстановление из JSON теряет позиции курсоров и
        незавершённые правки. JSON остаётся запасным для страниц, которые ещё
        ни разу не открывали в совместном редактировании.
        """
        page = await self._session.get(Page, page_id)
        if page is None:
            raise not_found("error.page.page_not_found")

        return {
            "ydoc": base64.b64encode(page.ydoc).decode() if page.ydoc else None,
            "content": page.content,
            "title": page.title,
        }

    async def store(
        self,
        *,
        page_id: uuid.UUID,
        user_id: uuid.UUID,
        content: dict,
        text: str,
        ydoc: bytes,
        contributors: list[uuid.UUID],
    ) -> dict:
        """Сохранить состояние документа.

        Возвращает, была ли запись. Одинаковое содержимое не пишется: сосед
        сохраняет по таймеру, и без этой проверки каждая пауза в наборе
        добавляла бы версию в историю и событие в ленту.

        Сравниваются значения, а не текст JSON: порядок ключей в словаре
        безразличен, а сравнение строк объявляло бы изменением любую
        пересборку документа.
        """
        page = await self._session.get(Page, page_id)
        if page is None:
            raise not_found("error.page.page_not_found")

        rights = await self.rights_for(page, user_id)
        if not rights.can_edit:
            raise forbidden("error.page.edit_denied")

        if page.content == content:
            # Двоичное состояние всё равно обновляется: в нём есть история
            # правок, которой в JSON нет, и оно расходится с содержимым даже
            # тогда, когда содержимое не менялось.
            await self._session.execute(
                update(Page).where(Page.id == page.id).values(ydoc=ydoc)
            )
            await self._session.commit()
            return {"saved": False}

        before = page.content
        # Версия пишется до правки: она обязана хранить то, что было, иначе
        # восстанавливать нечего. Подряд идущие правки одного человека
        # сливаются в одну, это делает сама служба истории.
        await PageHistoryService(self._session).record(page, user_id)

        everyone = {one for one in contributors}
        everyone.add(user_id)
        if page.creator_id is not None:
            everyone.add(page.creator_id)
        merged = sorted({*(page.contributor_ids or []), *everyone}, key=str)

        await self._session.execute(
            update(Page)
            .where(Page.id == page.id)
            .values(
                content=content,
                text_content=text,
                ydoc=ydoc,
                last_updated_by_id=user_id,
                contributor_ids=merged,
            )
        )
        await self._session.commit()

        updated = await self._session.get(Page, page_id)
        await self._session.refresh(updated)
        await BacklinkService(self._session).rebuild(updated)
        # Снимки включённых блоков пересобираются здесь же: это единственное
        # место, где содержимое страницы меняется, и снимок, отставший от
        # источника, показывался бы читателям как свежий.
        await TransclusionService(self._session).sync(updated)
        await self._session.commit()

        await self._follow_up(updated, user_id, before, list(everyone))
        return {
            "saved": True,
            "updatedAt": updated.updated_at.isoformat() if updated.updated_at else None,
        }

    async def _follow_up(
        self,
        page: Page,
        actor_id: uuid.UUID,
        before: dict | None,
        contributors: list[uuid.UUID],
    ) -> None:
        """Всё, что следует за записью: подписки, уведомления, векторы.

        Отказ здесь не отменяет сохранения. Страница уже записана, и откатывать
        её из-за неотправленного уведомления неверно; при этом молчаливым отказ
        быть не должен, поэтому он попадает в журнал.
        """
        from tessera_api.services.backlinks import extract_user_mentions

        try:
            watchers = WatcherService(self._session)
            for one in contributors:
                # Правивший становится наблюдателем: в v1 так же, и именно
                # отсюда берутся получатели ленты обновлений.
                await watchers.watch_page(user_id=one, page=page)

            notifications = NotificationService(
                self._session, self._realtime, self._mailer, self._digest
            )

            fresh = set(extract_user_mentions(page.content)) - set(
                extract_user_mentions(before)
            )
            if fresh:
                await notifications.notify_page_event(
                    page=page,
                    kind=NotificationType.PAGE_USER_MENTION,
                    user_ids=sorted(fresh, key=str),
                    actor_id=actor_id,
                )

            # Лента обновлений уходит наблюдателям, кроме тех, кто правил:
            # человеку не сообщают о его собственной правке.
            watching = set(await watchers.watcher_ids(page.id))
            audience = sorted(watching - set(contributors), key=str)
            if audience:
                await notifications.notify_page_event(
                    page=page,
                    kind=NotificationType.PAGE_UPDATED,
                    user_ids=audience,
                    actor_id=actor_id,
                )
            await self._session.commit()
            # Сигналы и письма уходят после фиксации: до неё они указывали бы
            # на записи, которых в базе ещё нет.
            await notifications.flush()
        except Exception:  # noqa: BLE001 — страница уже сохранена
            logger.exception("Последействие сохранения страницы %s не выполнено", page.id)
            await self._session.rollback()

        if self._queue is not None:
            from tessera_api.infrastructure.queue import JobName

            try:
                await self._queue.enqueue(JobName.INDEX_PAGE_EMBEDDING, page_id=str(page.id))
            except Exception:  # noqa: BLE001 — поиск по смыслу не важнее записи
                logger.warning("Пересчёт векторов страницы %s не поставлен", page.id)

        if self._realtime is not None:
            try:
                await self._realtime.publish_page_event(
                    self._session,
                    page,
                    {
                        "operation": "updateOne",
                        "spaceId": str(page.space_id),
                        "entity": ["pages"],
                        "id": str(page.id),
                        "payload": {"title": page.title, "icon": page.icon},
                    },
                )
            except Exception:  # noqa: BLE001 — событие не важнее записи
                logger.warning("Событие о правке страницы %s не отправлено", page.id)


def decode_ydoc(raw: str | None) -> bytes:
    """Двоичное состояние из base64. Негодное значение — отказ, а не пустота.

    Пустое состояние, записанное вместо испорченного, стирает документ: при
    следующем открытии страница окажется пустой, и виноватым будет выглядеть
    редактор.
    """
    if not raw:
        raise ValueError("состояние документа пусто")
    return base64.b64decode(raw, validate=True)
