"""Выгрузка страницы в PDF.

Страницу рисует не сервер, а браузер: разметка страницы живёт на клиенте, и
второй её рисовальщик на сервере расходился бы с тем, что человек видит на
экране. Поэтому Gotenberg открывает у клиента отдельный адрес отрисовки и
печатает его в PDF.

Отсюда три особенности, каждая из которых имеет причину.

**Задание, а не ответ на запрос.** Отрисовка ветви из сотни страниц занимает
десятки секунд; держать запрос открытым столько нельзя, и выгрузка становится
заданием, которое клиент опрашивает — тем же способом, что и ввоз архива.

**Токен отрисовки.** У безголового браузера нет ни куки, ни сессии.
Учётными данными служит короткоживущий токен, выписанный на одно задание: он
открывает ровно те страницы, которые в это задание вошли.

**Состав документа решается здесь, а не при отрисовке.** Кто что вправе читать,
известно в момент запроса, пока человек ещё в контексте. Отрисовщик приходит
позже и только с токеном; решай он сам, закрытая подстраница попала бы в
документ того, кому она не открыта.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import httpx
import jwt
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found, unauthorized
from tessera_api.infrastructure.models import FileTask, Page, User
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.pages import PageService
from tessera_api.services.shares import ShareService
from tessera_api.services.tokens import TokenService

logger = logging.getLogger(__name__)

#: Вид токена отрисовки. Отдельный: токен доступа, попавший в браузер печати,
#: дал бы ему право ходить в приложение от имени человека.
TOKEN_TYPE = "pdf-render"

#: Сколько живёт токен отрисовки. Печать одной ветви укладывается в минуты;
#: больше держать нельзя — токен уходит в адресную строку браузера печати.
TOKEN_EXPIRES = timedelta(minutes=10)

#: Сколько страниц собирается в один документ. Предел из v1: документ из тысячи
#: страниц не столько печатается, сколько роняет отрисовщик по памяти.
MAX_PAGES = 100

STATUS_PROCESSING = "processing"
STATUS_SUCCESS = "success"
STATUS_FAILED = "failed"

#: Подвал с номерами страниц. Gotenberg требует целый документ, а не обрывок.
FOOTER_HTML = """<!doctype html>
<html>
  <head>
    <style>
      body { margin: 0; font-family: sans-serif; }
      .footer { width: 100%; font-size: 9px; color: #888; text-align: right; padding: 0 14mm; }
    </style>
  </head>
  <body>
    <div class="footer"><span class="pageNumber"></span> / <span class="totalPages"></span></div>
  </body>
</html>"""


class PdfExportService:
    def __init__(
        self,
        session: AsyncSession,
        *,
        secret: str,
        gotenberg_url: str = "",
        render_base_url: str = "",
        timeout: float = 120.0,
        storage: Storage | None = None,
        queue: JobQueue | None = None,
    ) -> None:
        self._session = session
        self._secret = secret
        self._gotenberg_url = gotenberg_url.rstrip("/")
        self._render_base_url = render_base_url.rstrip("/")
        self._timeout = timeout
        self._storage = storage
        self._queue = queue
        self._access = PageAccessService(session)

    async def create_task(
        self,
        *,
        page_id: str,
        include_children: bool,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
    ) -> dict:
        """Поставить выгрузку в очередь. Возвращает опрашиваемое задание."""
        if not self._gotenberg_url:
            raise bad_request("error.pdf_export.pdf_export_needs_gotenberg_url_to")

        page = await self._access.load_page(page_id, workspace_id)
        # Смотреть достаточно: в PDF попадает ровно то, что человек и так видит
        # на экране.
        await self._access.validate_can_view(page, user_id)

        page_ids = (
            await self._viewable_branch(page, user_id) if include_children else [page.id]
        )

        task_id = uuid.uuid4()
        title = page.title or "untitled"
        file_name = f"{_safe(title)}.pdf"
        key = f"{workspace_id}/exports/{task_id}/{file_name}"

        self._session.add(
            FileTask(
                id=task_id,
                type="export",
                source="pdf",
                status=STATUS_PROCESSING,
                file_name=file_name,
                file_path=key,
                file_ext="pdf",
                creator_id=user_id,
                page_id=page.id,
                space_id=page.space_id,
                workspace_id=workspace_id,
                task_metadata={
                    "includeChildren": include_children,
                    "pageIds": [str(one) for one in page_ids],
                },
            )
        )
        await self._session.commit()

        if self._queue is not None:
            await self._queue.enqueue(JobName.PDF_EXPORT, task_id=str(task_id))

        return {"fileTaskId": str(task_id)}

    async def _locale_of(self, user_id: uuid.UUID | None) -> str | None:
        """Язык человека. Пусто, если его нет: тогда лист берёт запасной."""
        if user_id is None:
            return None
        user = await self._session.get(User, user_id)
        return (user.locale or None) if user is not None else None

    async def _viewable_branch(self, page: Page, user_id: uuid.UUID) -> list[uuid.UUID]:
        """Страница и её потомки, доступные этому человеку.

        Отбор идёт по каждой странице: ограничение ставится на любую из ветви,
        и печать по одному лишь членству в пространстве вынесла бы закрытую
        подстраницу в общий документ.
        """
        pages = PageService(self._session)
        ids = [page.id, *await pages._descendants(page.id)]  # noqa: SLF001 — свой пакет

        allowed: list[uuid.UUID] = []
        for one in ids[:MAX_PAGES]:
            found = await self._session.get(Page, one)
            if found is None or found.deleted_at is not None:
                continue
            if (await self._access.rights(found, user_id)).can_view:
                allowed.append(found.id)
        return allowed

    def issue_render_token(self, task_id: uuid.UUID, workspace_id: uuid.UUID) -> str:
        now = datetime.now(UTC)
        return jwt.encode(
            {
                "fileTaskId": str(task_id),
                "workspaceId": str(workspace_id),
                "type": TOKEN_TYPE,
                "iat": int(now.timestamp()),
                "exp": int((now + TOKEN_EXPIRES).timestamp()),
            },
            self._secret,
            algorithm="HS256",
        )

    async def render_data(self, token: str) -> dict:
        """Отдать содержимое страниц браузеру печати.

        Единственные учётные данные здесь — токен. Он выписан на одно задание,
        и состав документа взят из этого задания, а не из запроса: иначе
        отрисовщик мог бы напечатать что угодно, предъявив чужой токен.
        """
        try:
            claims = jwt.decode(token, self._secret, algorithms=["HS256"])
        except jwt.PyJWTError as error:
            raise unauthorized("error.pdf_export.invalid_or_expired_render_token") from error

        if claims.get("type") != TOKEN_TYPE:
            raise unauthorized("error.pdf_export.invalid_or_expired_render_token")

        try:
            task_id = uuid.UUID(str(claims["fileTaskId"]))
            workspace_id = uuid.UUID(str(claims["workspaceId"]))
        except (KeyError, ValueError) as error:
            raise unauthorized("error.pdf_export.invalid_or_expired_render_token") from error

        task = await self._session.get(FileTask, task_id)
        if task is None or task.workspace_id != workspace_id:
            raise not_found("error.import.task_not_found")

        wanted = [
            uuid.UUID(one) for one in ((task.task_metadata or {}).get("pageIds") or [])
        ]
        if not wanted:
            wanted = [task.page_id] if task.page_id else []

        rows = (
            await self._session.execute(
                select(Page).where(Page.id.in_(wanted)).where(Page.deleted_at.is_(None))
            )
        ).scalars().all()
        order = {one: index for index, one in enumerate(wanted)}
        rows = sorted(rows, key=lambda one: order.get(one.id, 0))

        # Вложения подписываются, как для страницы по ссылке: у браузера
        # печати нет ни входа, ни куки, и без токенов картинки и диаграммы
        # уходят в PDF битыми ссылками. Подготовка берётся общая — второе её
        # описание разошлось бы с первым на первом же новом виде узла.
        shares = ShareService(self._session)
        tokens = TokenService(self._secret)
        return {
            "pages": [
                {
                    "pageId": str(one.id),
                    "title": one.title,
                    "content": await shares.public_content(one, tokens),
                }
                for one in rows
            ]
        }

    async def run(self, task_id: uuid.UUID) -> None:
        """Напечатать документ и положить его в хранилище."""
        task = await self._session.get(FileTask, task_id)
        if task is None or task.status != STATUS_PROCESSING:
            # Повторное исполнение того же задания не должно печатать второй раз.
            return

        try:
            if self._storage is None:
                raise bad_request("error.import.unavailable")
            body = await self._print(task)
            await self._storage.put(task.file_path, body)
            await self._session.execute(
                update(FileTask)
                .where(FileTask.id == task_id)
                .values(status=STATUS_SUCCESS, file_size=len(body))
            )
        except Exception as error:  # noqa: BLE001 — причина уходит в задание
            logger.exception("Выгрузка в PDF не удалась")
            await self._session.execute(
                update(FileTask)
                .where(FileTask.id == task_id)
                .values(status=STATUS_FAILED, error_message=str(error)[:500])
            )
        await self._session.commit()

    async def _print(self, task: FileTask) -> bytes:
        if not self._gotenberg_url or not self._render_base_url:
            raise bad_request("error.pdf_export.pdf_export_needs_gotenberg_url_to")

        token = self.issue_render_token(task.id, task.workspace_id)
        address = f"{self._render_base_url}/pdf-render/{task.page_id}?token={token}"
        # Язык заказавшего печать: у браузера печати нет ни входа, ни куки, и
        # без этого подписи от приложения — оглавление — уходят на листе
        # по-английски тому, кто по-английски не читает.
        speech = await self._locale_of(task.creator_id)
        if speech:
            address = f"{address}&locale={quote(speech)}"

        form = {
            "url": (None, address),
            # A4 в дюймах: Gotenberg принимает только их.
            "paperWidth": (None, "8.27"),
            "paperHeight": (None, "11.7"),
            "marginTop": (None, "0.7"),
            "marginBottom": (None, "0.7"),
            "marginLeft": (None, "0.55"),
            "marginRight": (None, "0.55"),
            "printBackground": (None, "true"),
            "preferCssPageSize": (None, "false"),
            # Признак готовности ставит сам отрисовщик, когда разложил все
            # страницы. Печать раньше даёт пустой или недорисованный документ.
            "waitForExpression": (
                None,
                "document.querySelector('[data-pdf-ready=\"true\"]') !== null",
            ),
            "footer.html": ("footer.html", FOOTER_HTML.encode(), "text/html"),
        }

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            answer = await client.post(
                f"{self._gotenberg_url}/forms/chromium/convert/url", files=form
            )
        if answer.status_code >= 400:
            raise RuntimeError(
                f"Gotenberg ответил {answer.status_code}: {answer.text[:300]}"
            )
        return answer.content

    async def download(
        self, task_id: uuid.UUID, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> tuple[str, bytes]:
        """Отдать готовый документ его заказчику."""
        task = await self._session.get(FileTask, task_id)
        if task is None or task.workspace_id != workspace_id:
            raise not_found("error.import.task_not_found")
        if task.creator_id != user_id:
            # Задание заводит один человек, и права в него уже вложены: отдавать
            # его другому значило бы отдавать состав документа, собранный не по
            # его правам.
            raise forbidden("error.space.access_denied")
        if task.status != STATUS_SUCCESS:
            raise bad_request("error.import.task_not_ready")
        if self._storage is None:
            raise bad_request("error.import.unavailable")

        body = await self._storage.get(task.file_path)
        return task.file_name, body


def _safe(name: str) -> str:
    """Имя файла без разделителей пути и управляющих знаков."""
    cleaned = "".join(
        " " if one in "\\/:*?\"<>|" else one for one in name if one.isprintable()
    ).strip()
    return (cleaned or "untitled")[:100]
