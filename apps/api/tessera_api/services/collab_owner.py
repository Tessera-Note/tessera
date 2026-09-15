"""Отметка владения документом совместного редактирования.

Документ Yjs живёт в памяти той реплики службы редактирования, что его
открыла, а рассылки состояния между репликами нет. Закрепление в прокси ведёт
соединения одного документа на одну реплику, но при смене состава, после
перечитанной вместо перезапуска настройки прокси и при подключении мимо прокси
документ может открыться на двух репликах сразу — и правки двух половин не
сойдутся, без единого отказа.

Отметка в Redis это запрещает. Реплика, открывшая документ, ставит ключ со
своим именем и сроком жизни и продлевает его, пока документ открыт; соединение
с документом, который числится за другой живой репликой, отвергается. Упавшая
реплика продлевать перестаёт, и по истечении срока документ свободен.

Недоступный Redis — отказ, а не пропуск: без отметки защита пропадает
незаметно, а отказ клиент показывает.
"""

from __future__ import annotations

from redis.asyncio import Redis
from redis.exceptions import RedisError

from tessera_api.domain.errors import bad_request, conflict, unavailable
from tessera_api.services.collab import page_id_of

KEY_PREFIX = "collab:owner:"

#: Длина имени реплики. Имя уходит в Redis значением и в журнал.
REPLICA_MAX = 200

# Взять или продлить одним сценарием: ключ ставится, если его нет, и
# продлевается, если он свой. Раздельные GET и SET оставляли бы окно, в котором
# ключ истекает или уходит другой реплике между проверкой и записью.
CLAIM = """
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return ARGV[1]
end
if current == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return current
"""

# Снимается только своя отметка. Чужую снимающий не держит, и её снятие
# открыло бы документ ещё одной реплике при живом владельце.
RELEASE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def owner_key(document: str) -> str:
    return f"{KEY_PREFIX}{document}"


class CollabOwnerService:
    def __init__(self, redis: Redis, *, ttl_ms: int, renew_every_ms: int) -> None:
        self._redis = redis
        self._ttl_ms = ttl_ms
        self._renew_every_ms = renew_every_ms

    async def claim(self, document: str, replica: str) -> dict:
        """Взять документ за репликой или подтвердить, что он уже её.

        Период продления уходит в ответе: срок и период живут в настройках
        приложения, и служба редактирования не держит второй их копии.
        """
        _validate(document, replica)
        owner = await self._eval(CLAIM, document, replica, self._ttl_ms)
        if owner != replica:
            raise conflict("error.collaboration.document_owned_elsewhere", {"owner": owner})
        return {"owned": True, "ttlMs": self._ttl_ms, "renewEveryMs": self._renew_every_ms}

    async def renew(self, documents: list[str], replica: str) -> dict:
        """Продлить открытые документы реплики разом.

        Отметка, перешедшая к другой реплике, возвращается списком: такой
        документ у этой реплики больше не свой, и её соединения с ним обязаны
        закрыться, иначе правки двух реплик разойдутся.
        """
        # Весь список, без усечения: документ, выпавший из продления, истёк бы
        # у живой реплики молча. Размер одного запроса ограничивает служба,
        # отправляя список порциями.
        wanted = list(dict.fromkeys(documents))
        for document in wanted:
            _validate(document, replica)
        if not wanted:
            return {"lost": [], "renewEveryMs": self._renew_every_ms}
        try:
            async with self._redis.pipeline(transaction=False) as pipe:
                for document in wanted:
                    pipe.eval(CLAIM, 1, owner_key(document), replica, self._ttl_ms)
                owners = await pipe.execute()
        except RedisError as error:
            raise unavailable("error.collaboration.owner_store_unavailable") from error
        lost = [
            {"documentName": document, "owner": owner}
            for document, owner in zip(wanted, owners, strict=True)
            if owner != replica
        ]
        return {"lost": lost, "renewEveryMs": self._renew_every_ms}

    async def release(self, document: str, replica: str) -> dict:
        """Снять свою отметку, когда документ выгружен из памяти реплики."""
        _validate(document, replica)
        released = await self._eval(RELEASE, document, replica)
        return {"released": bool(released)}

    async def _eval(self, script: str, document: str, *args: object) -> object:
        try:
            return await self._redis.eval(script, 1, owner_key(document), *args)
        except RedisError as error:
            raise unavailable("error.collaboration.owner_store_unavailable") from error


def _validate(document: str, replica: str) -> None:
    if page_id_of(document) is None:
        raise bad_request("error.collaboration.document_invalid")
    if not replica or len(replica) > REPLICA_MAX:
        raise bad_request("error.collaboration.replica_missing")
