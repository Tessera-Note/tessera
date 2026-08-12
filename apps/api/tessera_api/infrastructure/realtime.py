"""Канал событий: транспорт.

Второй канал реального времени, не редакторский. Совместное редактирование
живёт отдельно (`/collab`, Hocuspocus и Yjs) и с этим каналом не пересекается ни
транспортом, ни видом токена, ни средством согласования между репликами.
Подменять один другим запрещено правилами проекта, и это не формальность: у них
разные модели доставки и разные последствия потери сообщения.

Здесь только транспорт: соединения, комнаты, рассылка. Никаких правил доступа —
они в `services/realtime.py`.

**Протокол сохранён.** Берётся `python-socketio`, а не голый WebSocket Litestar,
потому что на клиенте `socket.io-client` 4.8.3, а у Socket.IO собственный
протокол поверх WebSocket: рукопожатие, пинги, номера пакетов, разбор событий.
Голый WebSocket на сервере означал бы одновременную замену клиента, то есть
слияние двух несвязанных работ в одну.

## Комнаты

Четыре вида, все назначает сервер:

- `user-<id>` — личные события и адресация конкретному человеку;
- `workspace-<id>` — рабочее пространство целиком;
- `space-<id>` — по одной на каждое доступное пространство;
- `base-<pageId>` — по явной подписке, для встроенных баз.

Клиент попросить комнату не может. Возможность самому войти в `space-<id>` была
бы обходом всей модели доступа: через события уходит настоящее содержимое —
заголовки страниц и тела комментариев.

## Как отдаётся команда чужой реплике

У `python-socketio` нет `fetchSockets`: адресовать сокет чужой реплики можно
только зная его идентификатор, а перечислить чужие — нечем. Поэтому заведён
управляющий канал: реплика публикует в него команду, каждая исполняет её над
своими соединениями и только над своими.

Это дешевле, чем в v1. Там отзыв сессии запрашивал **все** сокеты кластера и
перебирал их: стоимость линейна по числу соединений во всём кластере, а не по
числу соединений отзываемого человека. Здесь каждая реплика смотрит только свой
список.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from dataclasses import dataclass
from urllib.parse import urlsplit

import socketio
from redis.asyncio import Redis

logger = logging.getLogger(__name__)

#: Канал команд между репликами. Отдельный от канала самого Socket.IO: тот
#: принадлежит библиотеке, и подмешивать в него своё нельзя.
CONTROL_CHANNEL = "v2:realtime:control"

#: Имя события, которым уходит всё, кроме уведомлений. Как в v1: клиент
#: разбирает `operation` внутри полезной нагрузки.
EVENT = "message"

#: Уведомления идут отдельным именем. Полезной нагрузки, требующей проверки
#: прав, у них нет — только идентификатор и вид, содержимое клиент забирает по
#: HTTP, где список фильтруется по доступности страниц.
NOTIFICATION_EVENT = "notification"


def user_room(user_id: uuid.UUID) -> str:
    return f"user-{user_id}"


def workspace_room(workspace_id: uuid.UUID) -> str:
    return f"workspace-{workspace_id}"


def space_room(space_id: uuid.UUID) -> str:
    return f"space-{space_id}"


def base_room(page_id: uuid.UUID) -> str:
    return f"base-{page_id}"


@dataclass(frozen=True, slots=True)
class Identity:
    """Кто стоит за соединением.

    Идентификатор сессии здесь обязателен. Без него отзыв сессии не закрывает
    канал: токен живёт тридцать дней, и вышедший на чужой машине продолжал бы
    получать события.
    """

    user_id: uuid.UUID
    workspace_id: uuid.UUID
    session_id: uuid.UUID


def origin_allowed(origin: str | None, app_url: str) -> bool:
    """Пускать ли соединение с этой страницы.

    Происхождение сверяется, а не разрешается всем. В v1 стоит `origin: '*'`, и
    от подключения со стороннего сайта защищает только `samesite=lax` у куки —
    то есть одна мера вместо двух. Здесь их две.

    Отсутствие заголовка — это не браузер: так приходят проверки и служебные
    клиенты. Им отказывать нечего, у них и куки взяться неоткуда, а
    аутентификацию они проходят ту же.
    """
    if not origin:
        return True
    ours = urlsplit(app_url)
    theirs = urlsplit(origin)
    if not theirs.scheme or not theirs.netloc:
        return False
    return (theirs.scheme, theirs.netloc) == (ours.scheme, ours.netloc)


class RealtimeServer:
    """Сервер Socket.IO и учёт своих соединений.

    Список соединений локальный, в памяти, и это осознанно. Общий список в
    Redis пришлось бы поддерживать записью на каждое подключение и разрыв, а
    после падения реплики он остался бы с мусором, который никто не уберёт.
    Локальный список умирает вместе с процессом, которому он принадлежал.
    """

    def __init__(self, redis_url: str | None = None) -> None:
        manager = socketio.AsyncRedisManager(redis_url) if redis_url else None
        self.sio = socketio.AsyncServer(
            client_manager=manager,
            async_mode="asgi",
            # Происхождение сверяется своей проверкой на рукопожатии: у
            # библиотеки список задаётся заранее, а адрес приложения читается
            # из настроек.
            cors_allowed_origins="*",
            # Долгий опрос выключен. Липкие сессии на балансировщике для него
            # обязательны, а у соединения нет фазы, в которой запросы одного
            # клиента могли бы попасть на разные реплики.
            transports=["websocket"],
        )
        self._identities: dict[str, Identity] = {}
        self._control: asyncio.Task | None = None
        self._redis_url = redis_url
        #: Кто отправил команду. Redis доставляет опубликованное и самому
        #: отправителю, а своё уже исполнено на месте: без этой метки каждая
        #: команда выполнялась бы у себя дважды.
        self._host = uuid.uuid4().hex
        #: Что делать с командой. Проставляет служба: транспорт правил не знает.
        self.handler = None

    # --- учёт соединений -------------------------------------------------

    def remember(self, sid: str, identity: Identity) -> None:
        self._identities[sid] = identity

    def forget(self, sid: str) -> None:
        self._identities.pop(sid, None)

    def identity(self, sid: str) -> Identity | None:
        return self._identities.get(sid)

    def local_sids(self) -> list[tuple[str, Identity]]:
        # Копией: обход идёт с await внутри, а список меняется подключениями.
        return list(self._identities.items())

    # --- комнаты и рассылка ----------------------------------------------

    async def enter(self, sid: str, room: str) -> None:
        await self.sio.enter_room(sid, room)

    async def leave(self, sid: str, room: str) -> None:
        await self.sio.leave_room(sid, room)

    def rooms_of(self, sid: str) -> list[str]:
        return list(self.sio.rooms(sid))

    async def emit(
        self, event: str, payload: dict, *, room: str, skip_sid: str | None = None
    ) -> None:
        """Разослать в комнату.

        Отказ рассылки гасится в журнал. Мутация к этому моменту уже
        зафиксирована в базе, и пятисотый ответ из-за недоступного Redis
        соврал бы клиенту об исходе записи. Цена — потерянное событие: повторной
        доставки на этом канале нет ни здесь, ни в v1.
        """
        try:
            await self.sio.emit(event, payload, room=room, skip_sid=skip_sid)
        except Exception:  # noqa: BLE001 — запись уже произошла, рассылка вторична
            logger.exception("Событие %s в комнату %s не ушло", event, room)

    async def disconnect(self, sid: str) -> None:
        with contextlib.suppress(Exception):
            await self.sio.disconnect(sid)

    # --- команды между репликами -----------------------------------------

    async def publish_control(self, command: dict) -> None:
        """Отдать команду всем репликам, включая себя.

        Себе — тоже: иначе поведение зависело бы от того, на какую реплику
        пришёл запрос, и расхождение всплывало бы только при нескольких
        экземплярах.
        """
        await self.handle_control(command)
        if not self._redis_url:
            return
        try:
            client = Redis.from_url(self._redis_url, decode_responses=True)
            try:
                await client.publish(
                    CONTROL_CHANNEL, json.dumps({**command, "host": self._host})
                )
            finally:
                await client.aclose()
        except Exception:  # noqa: BLE001 — своя реплика уже обработала
            logger.exception("Команда %s другим репликам не ушла", command.get("do"))

    async def handle_control(self, command: dict) -> None:
        if self.handler is None:
            return
        if command.get("host") == self._host:
            # Своя команда, уже исполненная на месте при публикации.
            return
        try:
            await self.handler(command)
        except Exception:  # noqa: BLE001 — одна негодная команда не должна ронять слушателя
            logger.exception("Команда %s не выполнена", command.get("do"))

    async def start(self) -> None:
        if not self._redis_url or self._control is not None:
            return
        self._control = asyncio.create_task(self._listen())

    async def stop(self) -> None:
        if self._control is not None:
            self._control.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._control
            self._control = None

    async def _listen(self) -> None:
        """Слушать команды других реплик.

        Переподключение бесконечное. Слушатель, умерший на первом обрыве
        Redis, оставил бы реплику работающей, но не исполняющей отзыв сессии, и
        заметить это можно было бы только по чужой сессии, которая не
        закрывается.
        """
        while True:
            try:
                client = Redis.from_url(self._redis_url, decode_responses=True)
                pubsub = client.pubsub()
                await pubsub.subscribe(CONTROL_CHANNEL)
                async for message in pubsub.listen():
                    if message.get("type") != "message":
                        continue
                    try:
                        command = json.loads(message["data"])
                    except (TypeError, ValueError):
                        continue
                    await self.handle_control(command)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — обрыв Redis это не конец слушателя
                logger.exception("Слушатель команд оборвался, переподключаюсь")
                await asyncio.sleep(1)
