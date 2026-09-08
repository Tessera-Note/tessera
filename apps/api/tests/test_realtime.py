"""Канал событий.

Проверяется прежде всего отбор получателей. Рассылка сама по себе тривиальна, а
ошибка в отборе не проявляется отказом: она проявляется заголовком закрытой
страницы, ушедшим тому, кому эта страница не полагается, — и увидеть это можно
только у него на экране.

Второе по важности — рукопожатие. Канал отдаёт то же содержимое, что обычный
запрос, и его проверки обязаны совпадать с охраной маршрута побуквенно.
Разойдясь, они дают дверь, закрытую с одной стороны и открытую с другой.
"""

from __future__ import annotations

import inspect
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import _session_is_live
from tessera_api.domain.roles import SpaceRole, UserRole
from tessera_api.infrastructure.models import (
    Page,
    PageAccess,
    PagePermission,
    Space,
    SpaceMember,
    User,
    UserSession,
)
from tessera_api.infrastructure.realtime import (
    Identity,
    RealtimeServer,
    base_room,
    origin_allowed,
    space_room,
    user_room,
    workspace_room,
)
from tessera_api.services.page_access import ACCESS_RESTRICTED, PageAccessService
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.tokens import TokenService
from tests.conftest import needs_database

APP_URL = "https://tessera.example"
SECRET = "s" * 32


class TestOrigin:
    """Происхождение соединения.

    В v1 стоит `origin: '*'`, и от подключения со стороннего сайта защищает
    только `samesite=lax` у куки — одна мера вместо двух.
    """

    def test_our_own_address_is_allowed(self) -> None:
        assert origin_allowed(APP_URL, APP_URL) is True
        assert origin_allowed("https://tessera.example", f"{APP_URL}/") is True

    def test_another_site_is_refused(self) -> None:
        assert origin_allowed("https://evil.example", APP_URL) is False

    def test_the_same_host_over_http_is_refused(self) -> None:
        """Схема входит в сверку: по HTTP это уже не наша страница."""
        assert origin_allowed("http://tessera.example", APP_URL) is False

    def test_a_lookalike_host_is_refused(self) -> None:
        assert origin_allowed("https://tessera.example.evil.com", APP_URL) is False

    def test_absent_origin_is_allowed(self) -> None:
        """Заголовка нет — это не браузер.

        Так приходят проверки и служебные клиенты. Куки у них взяться неоткуда,
        а аутентификацию они проходят ту же, и отказывать им нечего.
        """
        assert origin_allowed(None, APP_URL) is True
        assert origin_allowed("", APP_URL) is True

    def test_rubbish_is_refused(self) -> None:
        assert origin_allowed("не адрес", APP_URL) is False
        assert origin_allowed("null", APP_URL) is False


class TestRoomNames:
    def test_names_do_not_collide_between_kinds(self) -> None:
        """Одинаковый идентификатор в разных видах комнат — разные комнаты.

        Иначе подписка на базу давала бы события пространства с тем же
        идентификатором, а он бывает тем же: страница и пространство берут
        идентификаторы из одного пространства значений.
        """
        one = uuid.uuid4()
        names = {user_room(one), workspace_room(one), space_room(one), base_room(one)}
        assert len(names) == 4


class ControlDouble(RealtimeServer):
    """Сервер, у которого есть только учёт и команды.

    Наследуется от настоящего: подмена не должна оказаться шире того, что
    подменяет.
    """

    def __init__(self) -> None:
        self._identities = {}
        self._control = None
        self._redis_url = None
        self._host = "double"
        self.handler = None
        self.disconnected: list[str] = []
        self.entered: list[tuple[str, str]] = []
        self.left: list[tuple[str, str]] = []
        self.emitted: list[tuple[str, str, dict]] = []
        self._rooms: dict[str, set[str]] = {}

    async def enter(self, sid: str, room: str) -> None:
        self.entered.append((sid, room))
        self._rooms.setdefault(sid, set()).add(room)

    async def leave(self, sid: str, room: str) -> None:
        self.left.append((sid, room))
        self._rooms.setdefault(sid, set()).discard(room)

    def rooms_of(self, sid: str) -> list[str]:
        return sorted(self._rooms.get(sid, set()))

    async def emit(
        self, event: str, payload: dict, *, room: str, skip_sid: str | None = None
    ) -> None:
        self.emitted.append((event, room, payload))

    async def disconnect(self, sid: str) -> None:
        self.disconnected.append(sid)

    async def publish_control(self, command: dict) -> None:
        await self.handle_control(command)


def test_the_double_matches_the_real_server() -> None:
    """Подмена обязана совпадать с настоящим классом по сигнатурам."""
    for name in ("enter", "leave", "rooms_of", "emit", "disconnect", "publish_control"):
        assert inspect.signature(getattr(ControlDouble, name)) == inspect.signature(
            getattr(RealtimeServer, name)
        ), name


class DatabaseDouble:
    """Источник сессий, отдающий ту самую, что откатывается."""

    def __init__(self, db_session: AsyncSession) -> None:
        self._session = db_session

    def session(self):  # noqa: ANN201
        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def scope():  # noqa: ANN202
            yield self._session

        return scope()


class CacheDouble:
    """Кеш в памяти, чтобы проверять сброс, а не доступность Redis."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.reads = 0

    async def get(self, key: str) -> str | None:
        self.reads += 1
        return self.values.get(key)

    async def set(self, key: str, value: str, ex: int | None = None) -> None:  # noqa: ARG002
        self.values[key] = value

    async def delete(self, key: str) -> None:
        self.values.pop(key, None)


def _service(session: AsyncSession, server: ControlDouble, cache: CacheDouble):  # noqa: ANN202
    return RealtimeService(
        server, DatabaseDouble(session), cache, TokenService(SECRET), APP_URL
    )


async def _person(session: AsyncSession, workspace, **extra) -> uuid.UUID:
    user_id = uuid.uuid4()
    await session.execute(
        insert(User).values(
            id=user_id,
            name="Проверочный",
            email=f"{uuid.uuid4().hex}@example.com",
            role=UserRole.MEMBER,
            workspace_id=workspace.id,
            **extra,
        )
    )
    return user_id


async def _space(session: AsyncSession, workspace) -> uuid.UUID:
    space_id = uuid.uuid4()
    await session.execute(
        insert(Space).values(
            id=space_id,
            name="Проверочное",
            slug=f"s{uuid.uuid4().hex[:8]}",
            workspace_id=workspace.id,
        )
    )
    return space_id


async def _member(session: AsyncSession, space_id: uuid.UUID, user_id: uuid.UUID) -> None:
    await session.execute(
        insert(SpaceMember).values(
            id=uuid.uuid4(), space_id=space_id, user_id=user_id, role=SpaceRole.WRITER
        )
    )


async def _page(
    session: AsyncSession, workspace, space_id: uuid.UUID, parent: uuid.UUID | None = None
) -> Page:
    page_id = uuid.uuid4()
    await session.execute(
        insert(Page).values(
            id=page_id,
            slug_id=uuid.uuid4().hex[:10],
            title="Проверочная",
            space_id=space_id,
            workspace_id=workspace.id,
            parent_page_id=parent,
            is_base=False,
        )
    )
    return await session.get(Page, page_id)


async def _restrict(session: AsyncSession, page: Page, allowed: list[uuid.UUID]) -> uuid.UUID:
    access_id = uuid.uuid4()
    await session.execute(
        insert(PageAccess).values(
            id=access_id,
            page_id=page.id,
            space_id=page.space_id,
            workspace_id=page.workspace_id,
            access_level=ACCESS_RESTRICTED,
            creator_id=allowed[0] if allowed else None,
        )
    )
    for user_id in allowed:
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                user_id=user_id,
                role=SpaceRole.WRITER,
            )
        )
    return access_id


@needs_database
class TestViewers:
    """Кому можно показывать страницу.

    Ровно та же логика, что у `rights`, и это не случайно: разойдясь, они дают
    страницу, которую человек видит по HTTP и не видит по каналу — или, что
    хуже, наоборот.
    """

    async def test_open_page_has_no_list(self, session: AsyncSession, workspace) -> None:
        """Отсутствие ограничений это `None`, а не пустое множество.

        Пустое означает «никому», и путать их нельзя: одно разрешает рассылку
        всему пространству, другое запрещает её целиком.
        """
        space_id = await _space(session, workspace)
        page = await _page(session, workspace, space_id)
        assert await PageAccessService(session).viewers_of(page) is None

    async def test_restricted_page_lists_the_permitted(
        self, session: AsyncSession, workspace
    ) -> None:
        space_id = await _space(session, workspace)
        allowed = await _person(session, workspace)
        outsider = await _person(session, workspace)
        await _member(session, space_id, allowed)
        await _member(session, space_id, outsider)

        page = await _page(session, workspace, space_id)
        await _restrict(session, page, [allowed])

        assert await PageAccessService(session).viewers_of(page) == {allowed}

    async def test_permission_without_space_membership_does_not_count(
        self, session: AsyncSession, workspace
    ) -> None:
        """Права на страницу выдаются внутри пространства.

        Выбывший из пространства теряет их вместе с ним, а запись о праве
        остаётся: без пересечения с составом пространства она продолжала бы
        пускать его на закрытую страницу.
        """
        space_id = await _space(session, workspace)
        gone = await _person(session, workspace)
        page = await _page(session, workspace, space_id)
        await _restrict(session, page, [gone])

        assert await PageAccessService(session).viewers_of(page) == set()

    async def test_nested_restrictions_intersect(
        self, session: AsyncSession, workspace
    ) -> None:
        """Право нужно на **каждом** ограниченном предке.

        Взяв объединение, мы отдали бы страницу тому, кому дали право на
        внутреннем ограничении и не давали на внешнем: внешнее обходилось бы
        созданием подстраницы со своим.
        """
        space_id = await _space(session, workspace)
        both = await _person(session, workspace)
        inner_only = await _person(session, workspace)
        for one in (both, inner_only):
            await _member(session, space_id, one)

        outer = await _page(session, workspace, space_id)
        inner = await _page(session, workspace, space_id, parent=outer.id)
        await _restrict(session, outer, [both])
        await _restrict(session, inner, [both, inner_only])

        assert await PageAccessService(session).viewers_of(inner) == {both}

    async def test_group_permission_is_expanded(
        self, session: AsyncSession, workspace
    ) -> None:
        from tessera_api.infrastructure.models import Group, GroupUser

        space_id = await _space(session, workspace)
        member = await _person(session, workspace)
        await _member(session, space_id, member)

        group_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"Группа {uuid.uuid4().hex[:6]}",
                workspace_id=workspace.id,
                is_default=False,
            )
        )
        await session.execute(
            insert(GroupUser).values(id=uuid.uuid4(), group_id=group_id, user_id=member)
        )

        page = await _page(session, workspace, space_id)
        access_id = await _restrict(session, page, [])
        await session.execute(
            insert(PagePermission).values(
                id=uuid.uuid4(),
                page_access_id=access_id,
                group_id=group_id,
                role=SpaceRole.WRITER,
            )
        )

        assert await PageAccessService(session).viewers_of(page) == {member}


@needs_database
class TestRecipients:
    async def test_open_space_broadcasts_to_the_room(
        self, session: AsyncSession, workspace
    ) -> None:
        space_id = await _space(session, workspace)
        page = await _page(session, workspace, space_id)

        server, cache = ControlDouble(), CacheDouble()
        await _service(session, server, cache).publish_page_event(
            session, page, {"operation": "test"}
        )

        assert [room for _, room, _ in server.emitted] == [space_room(space_id)]

    async def test_restricted_page_goes_only_to_the_permitted(
        self, session: AsyncSession, workspace
    ) -> None:
        """Событие несёт содержимое, поэтому комнате пространства его не отдать."""
        space_id = await _space(session, workspace)
        allowed = await _person(session, workspace)
        outsider = await _person(session, workspace)
        for one in (allowed, outsider):
            await _member(session, space_id, one)

        page = await _page(session, workspace, space_id)
        await _restrict(session, page, [allowed])

        server, cache = ControlDouble(), CacheDouble()
        await _service(session, server, cache).publish_page_event(
            session, page, {"operation": "test"}
        )

        rooms = {room for _, room, _ in server.emitted}
        assert rooms == {user_room(allowed)}
        assert space_room(space_id) not in rooms
        assert user_room(outsider) not in rooms

    async def test_a_page_nobody_may_see_goes_nowhere(
        self, session: AsyncSession, workspace
    ) -> None:
        """Пустой список получателей означает «не слать никому».

        Это законный исход, а не признак ошибки: закрытая страница может не
        иметь ни одного получателя среди участников пространства.
        """
        space_id = await _space(session, workspace)
        page = await _page(session, workspace, space_id)
        await _restrict(session, page, [])

        server, cache = ControlDouble(), CacheDouble()
        await _service(session, server, cache).publish_page_event(
            session, page, {"operation": "test"}
        )
        assert server.emitted == []

    async def test_the_answer_about_restrictions_is_cached(
        self, session: AsyncSession, workspace
    ) -> None:
        space_id = await _space(session, workspace)
        page = await _page(session, workspace, space_id)

        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        await service.publish_page_event(session, page, {"operation": "test"})
        assert cache.values

        await service.publish_page_event(session, page, {"operation": "test"})
        assert cache.reads == 2

    async def test_forgetting_the_cache_makes_the_next_event_recheck(
        self, session: AsyncSession, workspace
    ) -> None:
        """Сброс обязателен при каждом изменении прав.

        Без него до тридцати секунд только что закрытая страница продолжает
        уходить всей комнате.
        """
        space_id = await _space(session, workspace)
        allowed = await _person(session, workspace)
        await _member(session, space_id, allowed)
        page = await _page(session, workspace, space_id)

        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        await service.publish_page_event(session, page, {"operation": "test"})
        assert [room for _, room, _ in server.emitted] == [space_room(space_id)]

        await _restrict(session, page, [allowed])
        await session.commit()
        await service.forget_restrictions(space_id)

        server.emitted.clear()
        await service.publish_page_event(session, page, {"operation": "test"})
        assert [room for _, room, _ in server.emitted] == [user_room(allowed)]


@needs_database
class TestHandshake:
    async def _token(self, session: AsyncSession, workspace, **extra) -> tuple[str, uuid.UUID]:
        user_id = await _person(session, workspace)
        session_id = uuid.uuid4()
        await session.execute(
            insert(UserSession).values(
                id=session_id,
                user_id=user_id,
                workspace_id=workspace.id,
                expires_at=extra.pop("expires_at", datetime.now(UTC) + timedelta(days=1)),
                **extra,
            )
        )
        await session.commit()
        return (
            TokenService(SECRET).issue_access(user_id, workspace.id, session_id),
            user_id,
        )

    async def test_a_live_session_is_let_in(self, session: AsyncSession, workspace) -> None:
        token, user_id = await self._token(session, workspace)
        identity = await _service(session, ControlDouble(), CacheDouble()).authorize(token)
        assert identity is not None
        assert identity.user_id == user_id

    async def test_no_token_no_connection(self, session: AsyncSession, workspace) -> None:
        service = _service(session, ControlDouble(), CacheDouble())
        assert await service.authorize(None) is None
        assert await service.authorize("") is None
        assert await service.authorize("не токен") is None

    async def test_a_collab_token_is_refused(self, session: AsyncSession, workspace) -> None:
        """Вид токена сверяется: у токена редактирования сессии нет вовсе."""
        collab = TokenService(SECRET).issue_collab(uuid.uuid4(), workspace.id)
        assert await _service(session, ControlDouble(), CacheDouble()).authorize(collab) is None

    async def test_an_api_key_is_refused(self, session: AsyncSession, workspace) -> None:
        """У ключа API нет сессии, а значит нет и того, чем канал закрывают."""
        key = TokenService(SECRET).issue_api_key(
            user_id=uuid.uuid4(), workspace_id=workspace.id, api_key_id=uuid.uuid4()
        )
        assert await _service(session, ControlDouble(), CacheDouble()).authorize(key) is None

    async def test_an_access_token_without_a_session_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Подписи мало: канал закрывают отзывом сессии, а не сроком токена.

        Токен нужного вида, но без идентификатора сессии, подписан нами и
        разбирается без ошибок. Пустив его, канал остался бы открытым до конца
        срока токена, то есть тридцать дней, и ни выход, ни отзыв устройства
        его не закрыли бы.

        Отказ здесь обеспечен дважды, и это проверено внесением дефекта: убрав
        ранний выход, отказ всё равно даёт запрос сессии — сравнение с
        отсутствующим значением не находит ни одной строки. Ранний выход
        оставлен ради ясности намерения и одного сэкономленного обращения к
        базе, но полагаться на него одного было бы неверно.

        Проверка отдельная от проверок вида токена: те отвергают чужой вид и
        зеленеют независимо от того, смотрит ли код на сессию вообще.
        """
        import jwt

        user_id = await _person(session, workspace)
        await session.commit()
        crafted = jwt.encode(
            {
                "sub": str(user_id),
                "workspaceId": str(workspace.id),
                "type": "access",
                "iat": int(datetime.now(UTC).timestamp()),
                "exp": int((datetime.now(UTC) + timedelta(days=1)).timestamp()),
            },
            SECRET,
            algorithm="HS256",
        )
        # Сначала убеждаемся, что токен вообще разбирается: иначе отказ пришёл
        # бы от разбора, а не от проверки сессии, и проверка была бы пустой.
        payload = TokenService(SECRET).read(crafted)
        assert payload is not None and payload.session_id is None

        assert await _service(session, ControlDouble(), CacheDouble()).authorize(crafted) is None

    async def test_a_revoked_session_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        token, _ = await self._token(session, workspace, revoked_at=datetime.now(UTC))
        assert await _service(session, ControlDouble(), CacheDouble()).authorize(token) is None

    async def test_an_expired_session_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        token, _ = await self._token(
            session, workspace, expires_at=datetime.now(UTC) - timedelta(seconds=1)
        )
        assert await _service(session, ControlDouble(), CacheDouble()).authorize(token) is None

    async def test_a_deactivated_person_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        token, user_id = await self._token(session, workspace)
        await session.execute(
            update(User).where(User.id == user_id).values(deactivated_at=datetime.now(UTC))
        )
        await session.commit()
        assert await _service(session, ControlDouble(), CacheDouble()).authorize(token) is None

    async def test_the_handshake_matches_the_route_guard(
        self, session: AsyncSession, workspace
    ) -> None:
        """Канал и маршрут обязаны отвечать одинаково.

        Оба отдают одно и то же содержимое. Дверь, закрытая с одной стороны и
        открытая с другой, — это не полумера, а полностью открытая дверь.
        """
        service = _service(session, ControlDouble(), CacheDouble())

        cases = [
            ({}, True),
            ({"revoked_at": datetime.now(UTC)}, False),
            ({"expires_at": datetime.now(UTC) - timedelta(seconds=1)}, False),
        ]
        for extra, expected in cases:
            token, user_id = await self._token(session, workspace, **extra)
            payload = TokenService(SECRET).read(token)

            from tests.test_guards import ConnectionDouble

            by_guard = await _session_is_live(
                ConnectionDouble(session), payload.session_id, payload.user_id
            )
            by_channel = await service.authorize(token) is not None
            assert by_guard == by_channel == expected, extra


@needs_database
class TestControl:
    async def test_revoking_a_session_drops_its_sockets(
        self, session: AsyncSession, workspace
    ) -> None:
        """Отметка сессии отозванной не разрывает открытый сокет сама."""
        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        service._server.handler = service.handle_control  # noqa: SLF001

        doomed = Identity(uuid.uuid4(), workspace.id, uuid.uuid4())
        spared = Identity(uuid.uuid4(), workspace.id, uuid.uuid4())
        server.remember("a", doomed)
        server.remember("b", spared)

        await service.drop_sessions([doomed.session_id])
        assert server.disconnected == ["a"]

    async def test_dropping_nothing_touches_nothing(
        self, session: AsyncSession, workspace
    ) -> None:
        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        service._server.handler = service.handle_control  # noqa: SLF001

        server.remember("a", Identity(uuid.uuid4(), workspace.id, uuid.uuid4()))
        await service.drop_sessions([])
        assert server.disconnected == []

    async def test_losing_a_space_leaves_its_room(
        self, session: AsyncSession, workspace
    ) -> None:
        """Комната переживает снятие участника: её приводит в порядок команда.

        Без неё снятый остаётся в комнате пространства до переподключения и
        продолжает получать её события.
        """
        space_id = await _space(session, workspace)
        user_id = await _person(session, workspace)
        await _member(session, space_id, user_id)
        await session.commit()

        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        service._server.handler = service.handle_control  # noqa: SLF001

        identity = Identity(user_id, workspace.id, uuid.uuid4())
        server.remember("a", identity)
        for room in await service.rooms_for(identity):
            await server.enter("a", room)
        assert space_room(space_id) in server.rooms_of("a")

        await session.execute(
            update(SpaceMember)
            .where(SpaceMember.space_id == space_id)
            .where(SpaceMember.user_id == user_id)
            .values(deleted_at=datetime.now(UTC))
        )
        await session.commit()

        await service.resync_user(user_id)
        assert space_room(space_id) not in server.rooms_of("a")

    async def test_resync_keeps_base_subscriptions(
        self, session: AsyncSession, workspace
    ) -> None:
        """Подписка на базу явная, и снимать её пересчётом нельзя.

        Для клиента это выглядело бы самопроизвольной отпиской: он подписался
        один раз и второй раз не подпишется.
        """
        user_id = await _person(session, workspace)
        await session.commit()

        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        service._server.handler = service.handle_control  # noqa: SLF001

        identity = Identity(user_id, workspace.id, uuid.uuid4())
        server.remember("a", identity)
        page_id = uuid.uuid4()
        await server.enter("a", base_room(page_id))

        await service.resync_user(user_id)
        assert base_room(page_id) in server.rooms_of("a")

    async def test_a_command_touches_only_the_named_person(
        self, session: AsyncSession, workspace
    ) -> None:
        user_id = await _person(session, workspace)
        other_id = await _person(session, workspace)
        await session.commit()

        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        service._server.handler = service.handle_control  # noqa: SLF001

        server.remember("a", Identity(user_id, workspace.id, uuid.uuid4()))
        server.remember("b", Identity(other_id, workspace.id, uuid.uuid4()))

        await service.resync_user(user_id)
        assert {sid for sid, _ in server.entered} == {"a"}


@needs_database
class TestSweep:
    """Перепроверка живых соединений.

    Закрывает дефект v1: там истёкшая или вычищенная уборкой сессия открытый
    сокет не разрывала, и он получал события до тех пор, пока клиент сам не
    отключится.
    """

    async def _connected(
        self, session: AsyncSession, workspace, server: ControlDouble, sid: str, **extra
    ) -> uuid.UUID:
        user_id = await _person(session, workspace)
        session_id = uuid.uuid4()
        await session.execute(
            insert(UserSession).values(
                id=session_id,
                user_id=user_id,
                workspace_id=workspace.id,
                expires_at=extra.pop("expires_at", datetime.now(UTC) + timedelta(days=1)),
                **extra,
            )
        )
        server.remember(sid, Identity(user_id, workspace.id, session_id))
        return session_id

    async def test_a_live_connection_survives(self, session: AsyncSession, workspace) -> None:
        """Обратная сторона: без неё проход, рвущий всех, выглядел бы рабочим."""
        server, cache = ControlDouble(), CacheDouble()
        await self._connected(session, workspace, server, "a")
        await session.commit()

        assert await _service(session, server, cache).sweep() == 0
        assert server.disconnected == []

    async def test_an_expired_session_is_dropped(
        self, session: AsyncSession, workspace
    ) -> None:
        server, cache = ControlDouble(), CacheDouble()
        await self._connected(
            session, workspace, server, "a", expires_at=datetime.now(UTC) - timedelta(seconds=1)
        )
        await session.commit()

        assert await _service(session, server, cache).sweep() == 1
        assert server.disconnected == ["a"]

    async def test_a_deleted_session_row_is_dropped(
        self, session: AsyncSession, workspace
    ) -> None:
        """Уборка сессий удаляет строку и не разрывает сокет. Проход — разрывает."""
        server, cache = ControlDouble(), CacheDouble()
        session_id = await self._connected(session, workspace, server, "a")
        await session.commit()
        from sqlalchemy import delete

        await session.execute(delete(UserSession).where(UserSession.id == session_id))
        await session.commit()

        assert await _service(session, server, cache).sweep() == 1

    async def test_an_empty_server_does_not_touch_the_database(
        self, session: AsyncSession, workspace
    ) -> None:
        server, cache = ControlDouble(), CacheDouble()
        assert await _service(session, server, cache).sweep() == 0


@needs_database
class TestIncoming:
    """Что сервер принимает от клиента.

    Только подписку и отписку на базу. Ретранслируя присланное браузером,
    сервер отдал бы комнате то, чего сам не проверял.
    """

    def _identity(self, workspace) -> Identity:
        return Identity(uuid.uuid4(), workspace.id, uuid.uuid4())

    async def test_tree_events_from_the_browser_are_ignored(
        self, session: AsyncSession, workspace
    ) -> None:
        """Белый список операций, а не «всё, кроме пустого».

        Сообщение нарочно снабжено настоящим `pageId` доступной базы: без него
        разбор отвалился бы на разборе идентификатора, и проверка зеленела бы
        независимо от того, есть ли белый список вообще.
        """
        space_id = await _space(session, workspace)
        user_id = await _person(session, workspace)
        await _member(session, space_id, user_id)
        page = await _page(session, workspace, space_id)
        await session.execute(update(Page).where(Page.id == page.id).values(is_base=True))
        await session.commit()

        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        server.remember("a", Identity(user_id, workspace.id, uuid.uuid4()))

        for operation in ("refetchRootTreeNodeEvent", "commentCreated", "addTreeNode", "base:*"):
            await service.handle_message(
                "a",
                {
                    "operation": operation,
                    "pageId": str(page.id),
                    "spaceId": str(space_id),
                },
            )
        assert server.emitted == []
        assert server.entered == []

    async def test_rubbish_does_not_raise(self, session: AsyncSession, workspace) -> None:
        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        server.remember("a", self._identity(workspace))

        for data in (None, "строка", 42, [], {}, {"operation": "base:subscribe"}):
            await service.handle_message("a", data)
        assert server.entered == []

    async def test_subscription_to_a_plain_page_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        """Комната базы только для базы: иначе подписка обходит вид страницы."""
        space_id = await _space(session, workspace)
        user_id = await _person(session, workspace)
        await _member(session, space_id, user_id)
        page = await _page(session, workspace, space_id)
        await session.commit()

        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        server.remember("a", Identity(user_id, workspace.id, uuid.uuid4()))

        await service.handle_message(
            "a", {"operation": "base:subscribe", "pageId": str(page.id)}
        )
        assert server.entered == []

    async def test_subscription_to_a_restricted_base_is_refused(
        self, session: AsyncSession, workspace
    ) -> None:
        space_id = await _space(session, workspace)
        outsider = await _person(session, workspace)
        allowed = await _person(session, workspace)
        for one in (outsider, allowed):
            await _member(session, space_id, one)

        page = await _page(session, workspace, space_id)
        await session.execute(update(Page).where(Page.id == page.id).values(is_base=True))
        await _restrict(session, page, [allowed])
        await session.commit()

        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        server.remember("a", Identity(outsider, workspace.id, uuid.uuid4()))

        await service.handle_message(
            "a", {"operation": "base:subscribe", "pageId": str(page.id)}
        )
        assert server.entered == []

    async def test_subscription_to_an_allowed_base_works(
        self, session: AsyncSession, workspace
    ) -> None:
        space_id = await _space(session, workspace)
        user_id = await _person(session, workspace)
        await _member(session, space_id, user_id)

        page = await _page(session, workspace, space_id)
        await session.execute(update(Page).where(Page.id == page.id).values(is_base=True))
        await session.commit()

        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        server.remember("a", Identity(user_id, workspace.id, uuid.uuid4()))

        await service.handle_message(
            "a", {"operation": "base:subscribe", "pageId": str(page.id)}
        )
        assert server.entered == [("a", base_room(page.id))]

    async def test_unsubscribe_needs_no_checks(
        self, session: AsyncSession, workspace
    ) -> None:
        """Выход из комнаты ничего не раскрывает."""
        server, cache = ControlDouble(), CacheDouble()
        service = _service(session, server, cache)
        server.remember("a", self._identity(workspace))

        page_id = uuid.uuid4()
        await service.handle_message(
            "a", {"operation": "base:unsubscribe", "pageId": str(page_id)}
        )
        assert server.left == [("a", base_room(page_id))]

    async def test_an_unknown_socket_is_ignored(
        self, session: AsyncSession, workspace
    ) -> None:
        server, cache = ControlDouble(), CacheDouble()
        await _service(session, server, cache).handle_message(
            "чужой", {"operation": "base:subscribe", "pageId": str(uuid.uuid4())}
        )
        assert server.entered == []


@needs_database
class TestRooms:
    async def test_a_connection_gets_its_spaces(
        self, session: AsyncSession, workspace
    ) -> None:
        space_id = await _space(session, workspace)
        other_space = await _space(session, workspace)
        user_id = await _person(session, workspace)
        await _member(session, space_id, user_id)
        await session.commit()

        identity = Identity(user_id, workspace.id, uuid.uuid4())
        rooms = await _service(session, ControlDouble(), CacheDouble()).rooms_for(identity)

        assert user_room(user_id) in rooms
        assert workspace_room(workspace.id) in rooms
        assert space_room(space_id) in rooms
        assert space_room(other_space) not in rooms

    async def test_access_through_a_group_counts(
        self, session: AsyncSession, workspace
    ) -> None:
        """Права на пространство приходят двумя путями.

        Учёт только прямого членства выбрасывал бы из комнаты человека, у
        которого доступ остался через группу.
        """
        from tessera_api.infrastructure.models import Group, GroupUser

        space_id = await _space(session, workspace)
        user_id = await _person(session, workspace)

        group_id = uuid.uuid4()
        await session.execute(
            insert(Group).values(
                id=group_id,
                name=f"Группа {uuid.uuid4().hex[:6]}",
                workspace_id=workspace.id,
                is_default=False,
            )
        )
        await session.execute(
            insert(GroupUser).values(id=uuid.uuid4(), group_id=group_id, user_id=user_id)
        )
        await session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(), space_id=space_id, group_id=group_id, role=SpaceRole.READER
            )
        )
        await session.commit()

        rooms = await _service(session, ControlDouble(), CacheDouble()).rooms_for(
            Identity(user_id, workspace.id, uuid.uuid4())
        )
        assert space_room(space_id) in rooms


class TestServerBookkeeping:
    def test_a_forgotten_socket_is_not_remembered(self) -> None:
        server = ControlDouble()
        identity = Identity(uuid.uuid4(), uuid.uuid4(), uuid.uuid4())
        server.remember("a", identity)
        assert server.identity("a") == identity

        server.forget("a")
        assert server.identity("a") is None
        assert server.local_sids() == []

    def test_forgetting_twice_does_not_raise(self) -> None:
        """Разрыв приходит и на соединение, которое не дошло до учёта."""
        server = ControlDouble()
        server.forget("никогда не было")
        server.forget("никогда не было")

    def test_the_list_is_a_copy(self) -> None:
        """Обход идёт с await внутри, а список меняют подключения.

        Отдав сам словарь, обход падал бы на изменении во время итерации — то
        есть ровно тогда, когда соединений много.
        """
        server = ControlDouble()
        server.remember("a", Identity(uuid.uuid4(), uuid.uuid4(), uuid.uuid4()))
        snapshot = server.local_sids()
        server.forget("a")
        assert len(snapshot) == 1


class TestOwnCommandsAreNotRunTwice:
    """Redis доставляет опубликованное и самому отправителю.

    Своё уже исполнено на месте при публикации: без метки отправителя каждая
    команда выполнялась бы у себя дважды.
    """

    async def test_the_senders_own_message_is_skipped(self) -> None:
        server = RealtimeServer(None)
        seen: list[dict] = []

        async def handler(command: dict) -> None:
            seen.append(command)

        server.handler = handler
        await server.handle_control({"do": "test", "host": server._host})  # noqa: SLF001
        assert seen == []

        await server.handle_control({"do": "test", "host": "другая реплика"})
        assert len(seen) == 1

    async def test_a_broken_handler_does_not_kill_the_listener(self) -> None:
        server = RealtimeServer(None)

        async def handler(command: dict) -> None:
            raise RuntimeError("негодная команда")

        server.handler = handler
        await server.handle_control({"do": "test"})
