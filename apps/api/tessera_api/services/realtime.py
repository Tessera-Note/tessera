"""Канал событий: правила.

Главное в этой подсистеме — не рассылка, а отбор получателей. Комната бывает
только уровня пространства, а ограничения — уровня страницы, и потому право на
страницу перепроверяется **на каждом событии**, а не один раз при входе в
комнату. Сокет остаётся в комнате и после того, как страницу закрыли: без
перепроверки он продолжал бы получать её заголовки и тела комментариев.

Отбор трёхступенчатый, от дешёвого к дорогому:

1. есть ли в пространстве хоть одно ограничение — ответ живёт в Redis тридцать
   секунд;
2. есть ли у страницы ограниченный предок;
3. поимённый список тех, кому можно.

Первые два шага дёшевы и в подавляющем большинстве пространств сразу разрешают
рассылку всей комнате. Полный обход предков на каждое событие был бы слишком
дорог, а без первых двух шагов он выполнялся бы всегда.

**Кеш сбрасывается явно при каждом изменении ограничений и прав.** Тридцать
секунд — это окно, в котором только что закрытая страница ещё уходила бы всей
комнате. Кеш лежит в Redis, поэтому сброс видят все реплики.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from datetime import UTC, datetime

from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.database import Database
from tessera_api.infrastructure.models import Page, User, UserSession
from tessera_api.infrastructure.realtime import (
    EVENT,
    NOTIFICATION_EVENT,
    Identity,
    RealtimeServer,
    base_room,
    space_room,
    user_room,
    workspace_room,
)
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.tokens import TokenService

logger = logging.getLogger(__name__)

#: Сколько живёт ответ «в пространстве есть ограничения».
RESTRICTIONS_TTL = 30

#: Через сколько секунд проверять, живы ли ещё сессии открытых соединений.
#:
#: Закрывает дефект v1: там уборка сессий удаляет просроченные строки, но
#: открытый сокет не разрывает, и он получает события до тех пор, пока клиент
#: сам не отключится. У канала совместного редактирования такая перепроверка
#: есть, у этого её не было.
SWEEP_INTERVAL = 60

#: Операции, которые сервер принимает от клиента. Всё остальное молча
#: отбрасывается: шлюз не ретранслирует события дерева, присланные браузером.
BASE_SUBSCRIBE = "base:subscribe"
BASE_UNSUBSCRIBE = "base:unsubscribe"
ACCEPTED_OPERATIONS = frozenset({BASE_SUBSCRIBE, BASE_UNSUBSCRIBE})


def _restrictions_key(space_id: uuid.UUID) -> str:
    return f"v2:realtime:restricted:{space_id}"


class RealtimeService:
    """Правила канала событий.

    Держит подключение к базе, а не сессию: обработчики соединения живут вне
    запроса, и сессии, открытой на время запроса, у них нет.
    """

    def __init__(
        self,
        server: RealtimeServer,
        database: Database,
        cache: Redis,
        tokens: TokenService,
        app_url: str,
    ) -> None:
        self._server = server
        self._database = database
        self._cache = cache
        self._tokens = tokens
        self._app_url = app_url
        self._sweeper: asyncio.Task | None = None

    # --- рукопожатие ------------------------------------------------------

    async def authorize(self, token: str | None) -> Identity | None:
        """Кого пускать.

        Годной подписи мало. Обязательны идентификатор сессии в токене и живая,
        не отозванная запись сессии, у которой человек и рабочее пространство
        совпадают с токеном, а сам человек не отключён и не удалён. Ровно те же
        условия, что у обычного запроса: канал отдаёт то же содержимое, и
        разойтись эти проверки не должны.

        Ключ API сюда не годится намеренно: у него нет сессии, а значит нет и
        того, чем канал закрывают.
        """
        if not token:
            return None

        payload = self._tokens.read(token)
        if payload is None or payload.session_id is None:
            # Ранний выход экономит обращение к базе и делает намерение явным.
            # Защита при этом не на нём: запрос ниже сравнивает идентификатор
            # сессии и без него не находит ни одной строки. Проверено внесением
            # дефекта — убранный отсюда выход отказ не отменяет.
            return None

        async with self._database.session() as session:
            row = (
                await session.execute(
                    select(
                        UserSession.revoked_at,
                        UserSession.expires_at,
                        UserSession.workspace_id,
                        User.deactivated_at,
                        User.deleted_at,
                    )
                    .join(User, User.id == UserSession.user_id)
                    .where(UserSession.id == payload.session_id)
                    .where(UserSession.user_id == payload.user_id)
                )
            ).first()

        if row is None:
            return None
        if row.revoked_at is not None or row.deactivated_at is not None:
            return None
        if row.deleted_at is not None or row.expires_at <= datetime.now(UTC):
            return None
        if row.workspace_id != payload.workspace_id:
            return None

        return Identity(
            user_id=payload.user_id,
            workspace_id=payload.workspace_id,
            session_id=payload.session_id,
        )

    async def rooms_for(self, identity: Identity) -> list[str]:
        """Комнаты, в которые заводится соединение.

        Считаются один раз при подключении. Сами они не пересматриваются:
        соответствие после изменения состава пространств наводит явный вызов
        `resync_user`, и только после фиксации транзакции — до неё запрос
        прочитал бы прежние права и не изменил бы ничего.
        """
        async with self._database.session() as session:
            spaces = await SpaceMemberRepo(session).space_ids_for(identity.user_id)

        return [
            user_room(identity.user_id),
            workspace_room(identity.workspace_id),
            *[space_room(one) for one in spaces],
        ]

    # --- отбор получателей ------------------------------------------------

    async def _space_restricted(self, session: AsyncSession, space_id: uuid.UUID) -> bool:
        key = _restrictions_key(space_id)
        try:
            cached = await self._cache.get(key)
        except Exception:  # noqa: BLE001 — недоступный кеш это не отказ рассылки
            cached = None

        if cached is not None:
            return cached == "1"

        answer = await PageAccessService(session).space_has_restrictions(space_id)
        try:
            await self._cache.set(key, "1" if answer else "0", ex=RESTRICTIONS_TTL)
        except Exception:  # noqa: BLE001 — без кеша дороже, но верно
            logger.debug("Ответ об ограничениях пространства %s не закеширован", space_id)
        return answer

    async def forget_restrictions(self, space_id: uuid.UUID) -> None:
        """Сбросить кеш ограничений пространства.

        Вызывается при каждом изменении ограничений и прав на страницу.
        Пропущенный сброс означает окно до тридцати секунд, в котором только
        что закрытая страница ещё рассылается всей комнате.
        """
        try:
            await self._cache.delete(_restrictions_key(space_id))
        except Exception:  # noqa: BLE001 — истечёт по сроку
            logger.warning("Кеш ограничений пространства %s не сброшен", space_id)

    async def recipients_for(
        self, session: AsyncSession, page: Page
    ) -> set[uuid.UUID] | None:
        """Кому можно отдать событие об этой странице.

        `None` означает «всему пространству». Пустое множество — «никому», и
        это законный ответ: страница может быть закрыта от всех, кроме тех, кто
        сейчас не в сети.
        """
        if not await self._space_restricted(session, page.space_id):
            return None
        return await PageAccessService(session).viewers_of(page)

    # --- рассылка ---------------------------------------------------------

    async def publish_page_event(
        self,
        session: AsyncSession,
        page: Page,
        payload: dict,
        *,
        skip_sid: str | None = None,
    ) -> None:
        """Событие о странице с отбором получателей.

        Отправить всей комнате и понадеяться, что лишние выбросят, нельзя:
        событие несёт заголовок страницы или тело комментария, то есть само по
        себе является выдачей содержимого.

        Исключается один сокет-инициатор, а не все сокеты человека. Исключение
        по человеку молча лишало бы остальные его вкладки событий закрытых
        страниц: до них событие иначе не дойдёт, обычная рассылка их не
        покрывает.
        """
        allowed = await self.recipients_for(session, page)
        if allowed is None:
            await self._server.emit(
                EVENT, payload, room=space_room(page.space_id), skip_sid=skip_sid
            )
            return

        for user_id in allowed:
            await self._server.emit(
                EVENT, payload, room=user_room(user_id), skip_sid=skip_sid
            )

    async def publish_to_space(self, space_id: uuid.UUID, payload: dict) -> None:
        """Событие без содержимого — всему пространству.

        Годится только тому, что содержимого не несёт: клиент по такому событию
        выбрасывает поддерево и перезапрашивает его обычным маршрутом с полной
        проверкой доступа.
        """
        await self._server.emit(EVENT, payload, room=space_room(space_id))

    async def notify(self, user_id: uuid.UUID, notification_id: uuid.UUID, kind: str) -> None:
        """Сигнал «перезапроси уведомления».

        Отдельным именем события и без содержимого: идентификатор и вид.
        Список клиент забирает по HTTP, где он фильтруется по доступности
        страниц.
        """
        await self._server.emit(
            NOTIFICATION_EVENT,
            {"id": str(notification_id), "type": kind},
            room=user_room(user_id),
        )

    # --- команды между репликами -----------------------------------------

    async def drop_sessions(self, session_ids: list[uuid.UUID]) -> None:
        """Разорвать соединения перечисленных сессий.

        Отметка сессии отозванной не разрывает уже открытый сокет: он прошёл
        проверку при подключении и живёт дальше сам по себе. Без этого вызова
        выход и отзыв устройства канал не закрывают.
        """
        if not session_ids:
            return
        await self._server.publish_control(
            {"do": "drop-sessions", "sessions": [str(one) for one in session_ids]}
        )

    async def resync_user(self, user_id: uuid.UUID) -> None:
        """Привести комнаты человека в соответствие его нынешним правам.

        Вызывать **после** фиксации транзакции: до неё запрос прочитал бы
        прежний состав и не изменил бы ничего. Без вызова снятый участник
        остаётся в комнате пространства до переподключения и продолжает
        получать её события.
        """
        await self._server.publish_control({"do": "resync-user", "user": str(user_id)})

    async def handle_control(self, command: dict) -> None:
        """Исполнить команду над своими соединениями."""
        action = command.get("do")

        if action == "drop-sessions":
            wanted = {str(one) for one in command.get("sessions") or []}
            for sid, identity in self._server.local_sids():
                if str(identity.session_id) in wanted:
                    await self._server.disconnect(sid)
            return

        if action == "resync-user":
            user = str(command.get("user") or "")
            for sid, identity in self._server.local_sids():
                if str(identity.user_id) == user:
                    await self._resync_socket(sid, identity)

    async def _resync_socket(self, sid: str, identity: Identity) -> None:
        wanted = set(await self.rooms_for(identity))
        # Комнаты баз не трогаются: подписка на них явная, и снятие её здесь
        # выглядело бы для клиента самопроизвольной отпиской.
        current = {
            room
            for room in self._server.rooms_of(sid)
            if room.startswith(("space-", "workspace-", "user-"))
        }
        for room in current - wanted:
            await self._server.leave(sid, room)
        for room in wanted - current:
            await self._server.enter(sid, room)

    # --- запуск и остановка ----------------------------------------------

    async def start(self) -> None:
        """Поднять слушателя команд и перепроверку соединений."""
        await self._server.start()
        if self._sweeper is None:
            self._sweeper = asyncio.create_task(self._sweep_forever())

    async def stop(self) -> None:
        if self._sweeper is not None:
            self._sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._sweeper
            self._sweeper = None
        await self._server.stop()

    async def _sweep_forever(self) -> None:
        """Проход не должен умирать от одной неудачи.

        Он и заведён ради случая, когда никто не пришлёт команду: слушатель,
        умерший на первом отказе базы, оставил бы реплику с соединениями,
        которые уже не имеют права быть открытыми, и заметить это было бы
        нечем.
        """
        while True:
            try:
                await asyncio.sleep(SWEEP_INTERVAL)
                await self.sweep()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — один неудачный проход не конец
                logger.exception("Перепроверка соединений не удалась")

    # --- перепроверка живых соединений ------------------------------------

    async def sweep(self) -> int:
        """Разорвать соединения, у которых сессия перестала быть годной.

        Отзыв сессии закрывает канал сразу, командой. Этот проход закрывает
        второй случай: сессия истекла по сроку или её убрала периодическая
        уборка, и команды не было ни от кого. В v1 такое соединение жило до
        разрыва со стороны клиента.

        Возвращает число разорванных: по нему видно, что проход работает.
        """
        local = self._server.local_sids()
        if not local:
            return 0

        wanted = {identity.session_id for _, identity in local}
        async with self._database.session() as session:
            alive = {
                row[0]
                for row in (
                    await session.execute(
                        select(UserSession.id)
                        .join(User, User.id == UserSession.user_id)
                        .where(UserSession.id.in_(wanted))
                        .where(UserSession.revoked_at.is_(None))
                        .where(UserSession.expires_at > datetime.now(UTC))
                        .where(User.deactivated_at.is_(None))
                        .where(User.deleted_at.is_(None))
                    )
                ).all()
            }

        dropped = 0
        for sid, identity in local:
            if identity.session_id not in alive:
                await self._server.disconnect(sid)
                dropped += 1
        if dropped:
            logger.info("Разорвано соединений с негодной сессией: %d", dropped)
        return dropped

    # --- входящие сообщения ----------------------------------------------

    async def handle_message(self, sid: str, data: object) -> None:
        """Разобрать сообщение от клиента.

        Принимаются только подписка и отписка на базу. Всё остальное молча
        отбрасывается — в том числе события дерева: ретранслируя присланное
        браузером, сервер отдал бы комнате то, чего сам не проверял.
        """
        if not isinstance(data, dict):
            return
        operation = data.get("operation")
        if operation not in ACCEPTED_OPERATIONS:
            return

        identity = self._server.identity(sid)
        if identity is None:
            return

        raw = data.get("pageId")
        try:
            page_id = uuid.UUID(str(raw))
        except (TypeError, ValueError):
            return

        if operation == BASE_UNSUBSCRIBE:
            # Без проверок: выход из комнаты ничего не раскрывает.
            await self._server.leave(sid, base_room(page_id))
            return

        if await self._may_subscribe(identity, page_id):
            await self._server.enter(sid, base_room(page_id))

    async def _may_subscribe(self, identity: Identity, page_id: uuid.UUID) -> bool:
        """Пускать ли в комнату базы.

        Проверяется всё: страница есть в этом рабочем пространстве, она база,
        она не удалена, человек состоит в её пространстве и проходит
        ограничения. Комната базы переживает снятие прав так же, как комната
        пространства, поэтому события в ней тоже отбираются по получателям — но
        отказать надо уже здесь, а не только при рассылке.
        """
        async with self._database.session() as session:
            page = await session.get(Page, page_id)
            if page is None or page.deleted_at is not None:
                return False
            if page.workspace_id != identity.workspace_id or not page.is_base:
                return False
            return (await PageAccessService(session).rights(page, identity.user_id)).can_view
