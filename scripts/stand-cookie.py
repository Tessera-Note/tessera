"""Передать браузеру куку сеанса стенда, не показывая её значение.

Продолжение `stand-session.py`. Кука ставится ответом сервера — тем же способом,
каким её ставит само приложение: значение читается из файла и уходит заголовком
`Set-Cookie`, минуя переписку и журналы. Записать её из JavaScript нельзя:
приложение ставит куку с `httponly`, и браузер запрещает страницам её
перезаписывать.

Порядок:

    docker cp scripts/stand-session.py tessera-v2-api:/tmp/stand-session.py
    docker exec tessera-v2-api python /tmp/stand-session.py > .stand-session
    python3 scripts/stand-cookie.py

Затем открыть в браузере http://127.0.0.1:9099 — он поставит куку и переведёт на
стенд. Сервер отвечает один раз и завершается: держать его дольше незачем.

Файл `.stand-session` содержит учётные данные. Он в `.gitignore`, и после
осмотра его следует удалить.

**Только стенд.** Адрес перехода жёстко указывает на 127.0.0.1: боевой узел
этим способом не открывается.
"""

from __future__ import annotations

import pathlib
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

#: Где лежит выданный токен. Рядом с корнем репозитория, а не в исходниках.
TOKEN_FILE = pathlib.Path(__file__).resolve().parent.parent / ".stand-session"

#: Куда переводить после установки куки.
TARGET = "http://127.0.0.1:8080/home"

#: Порт передачи. Свой, а не порт стенда: куки принадлежат узлу, а не порту,
#: и поставленная здесь кука уйдёт и на 8080.
PORT = 9099


def main() -> None:
    if not TOKEN_FILE.exists():
        print(f"нет файла {TOKEN_FILE.name}: сначала выдайте сеанс", file=sys.stderr)
        raise SystemExit(1)

    token = TOKEN_FILE.read_text().strip()
    if not token:
        print(f"{TOKEN_FILE.name} пуст", file=sys.stderr)
        raise SystemExit(1)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 — имя из базового класса
            self.send_response(302)
            self.send_header("Set-Cookie", f"authToken={token}; Path=/; SameSite=Lax")
            self.send_header("Location", TARGET)
            self.end_headers()

        def log_message(self, *args: object) -> None:
            """Молча: обычный журнал сервера пишет строку запроса."""

    server = HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.handle_request()
    finally:
        server.server_close()


main()
