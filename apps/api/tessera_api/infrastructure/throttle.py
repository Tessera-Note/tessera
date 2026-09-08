"""Счётчики частоты запросов.

Окно фиксированное, не скользящее. Скользящее точнее на границе, но требует
хранить отметку каждого запроса; фиксированное — один счётчик с временем жизни.
Цена неточности здесь понятна и ограничена: на стыке двух окон предел
проходится дважды. Для защиты от перебора это приемлемо, для тарификации не
было бы.

Счёт ведётся в Redis, а не в памяти процесса: экземпляров приложения
несколько, и счётчик в памяти означал бы предел, умноженный на их число.

**Ключи намеренно отделены от v1 префиксом.** Обе версии на переходе смотрят в
один Redis, а хранят под своим ключом разное: v1 через `nest-lab` держит там
свою структуру. Общий ключ дал бы не общий счёт, а порчу обеих записей.
"""

from __future__ import annotations

from dataclasses import dataclass

from litestar.connection import ASGIConnection
from litestar.exceptions import HTTPException
from litestar.status_codes import HTTP_429_TOO_MANY_REQUESTS
from redis.asyncio import Redis

#: Префикс ключей. Отделяет счётчики v2 от чужих записей в том же Redis.
KEY_PREFIX = "v2:throttle:"

#: Увеличить счётчик и выставить срок только при заведении.
#:
#: Одной командой, потому что `INCR` и `EXPIRE` по отдельности оставляют окно,
#: в котором процесс умер между ними: ключ остаётся без срока навсегда, и
#: предел, взятый один раз, больше никогда не отпускает.
_HIT = """
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
"""


@dataclass(frozen=True, slots=True)
class Limit:
    """Именованный предел.

    Имя входит в ключ: два предела на одном маршруте (по адресу и по имени
    пользователя) обязаны считаться раздельно, иначе один расходует другой.
    """

    name: str
    limit: int
    window: int


#: Вход. Тот же предел, что в v1: десять попыток в минуту.
AUTH_LIMIT = Limit("auth", limit=10, window=60)

#: Вход через каталог, по паре провайдера и имени.
#:
#: Порог ниже прочих не из скупости. Цена превышения здесь — не отказ нам, а
#: блокировка настоящей учётной записи в корпоративном каталоге: перебор через
#: нас накручивает счётчик неудач у него. Пять попыток за пять минут — та же
#: величина, что в v1.
LDAP_LOGIN_LIMIT = Limit("ldap-login", limit=5, window=300)


class TooManyRequests(HTTPException):
    """Отказ по частоте.

    Отдельный класс, а не `AppError`: у отказа по частоте нет кода перевода из
    общего каталога, и заводить его там значило бы обещать сообщение, которого
    интерфейс не показывает — этот отказ приходит на автоматические обращения.
    """

    def __init__(self, retry_after: int) -> None:
        super().__init__(
            status_code=HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests",
            headers={"Retry-After": str(retry_after)},
        )


class Throttle:
    """Счётчик обращений.

    Скрипт регистрируется один раз на подключении: `register_script` шлёт
    `EVALSHA` и подгружает тело только при промахе кеша сервера.
    """

    def __init__(self, client: Redis) -> None:
        self._hit = client.register_script(_HIT)

    async def allow(self, key: str, limit: Limit) -> bool:
        """Учесть обращение. `False` означает, что предел пройден."""
        current = await self._hit(keys=[f"{KEY_PREFIX}{limit.name}:{key}"], args=[limit.window])
        return int(current) <= limit.limit

    async def check(self, key: str, limit: Limit) -> None:
        """То же, но отказом.

        Отдельный метод, потому что вызывающему почти всегда нужен именно
        отказ, а `if not await allow(...)` в каждом месте — это четыре шанса
        забыть `not`.
        """
        if not await self.allow(key, limit):
            raise TooManyRequests(limit.window)


def client_ip(connection: ASGIConnection, hops: int) -> str:
    """Адрес обращающегося с поправкой на обратные прокси.

    Приложение стоит за nginx, и адрес сокета там всегда один и тот же. Считать
    по нему значит завести один общий счётчик на всех, то есть отказать всем
    из-за одного.

    Доверяется ровно `hops` последних записей заголовка, как в v1 через
    `trustProxy`. Брать первую запись нельзя: её пишет обращающийся, и предел
    обходился бы подставным значением. При `hops` = 0 заголовок игнорируется
    целиком: прокси нет, значит и заголовку взяться неоткуда.
    """
    fallback = connection.client.host if connection.client else "unknown"
    if hops <= 0:
        return fallback

    raw = connection.headers.get("x-forwarded-for")
    if not raw:
        return fallback

    chain = [one.strip() for one in raw.split(",") if one.strip()]
    if not chain:
        return fallback

    # Отсчёт справа: слева стоит то, что прислал обращающийся, справа — то, что
    # дописали наши прокси. Доверять можно только последним.
    index = max(0, len(chain) - hops)
    return chain[index]
