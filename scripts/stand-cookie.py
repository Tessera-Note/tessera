"""Hand the stand session cookie to the browser without showing its value.

The continuation of `stand-session.py`. The cookie is set by the server's
answer — the same way the application itself sets it: the value is read from a
file and travels in a `Set-Cookie` header, bypassing the conversation and the
logs. Writing it from JavaScript is not possible: the application sets the
cookie as `httponly`, and the browser forbids pages from overwriting it.

The order:

    docker cp scripts/stand-session.py tessera-v2-api:/tmp/stand-session.py
    docker exec tessera-v2-api python /tmp/stand-session.py > .stand-session
    python3 scripts/stand-cookie.py

Then open http://localhost:9099 in the browser — it will set the cookie and
redirect to the stand. The server answers once and exits: there is no reason to
keep it running longer.

The host matters. A cookie belongs to a host rather than to a port, and one set
on `localhost` will not travel to `127.0.0.1`. Open the stand by the same name
`APP_URL` is set to: the event channel compares the page's origin against it and
refuses the connection on a mismatch — the pages still work while live updates
simply do not arrive, and the stand looks broken where it is intact.

The `.stand-session` file holds credentials. It is in `.gitignore`, and it
should be deleted once the inspection is over.

**The stand only.** The redirect address points firmly at 127.0.0.1: a
production host is not opened this way.
"""

from __future__ import annotations

import os
import pathlib
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

#: Where the issued token lies. Next to the repository root, not in the sources.
TOKEN_FILE = pathlib.Path(__file__).resolve().parent.parent / ".stand-session"

#: The address the stand is opened at. The same one the application has in
#: `APP_URL`: a mismatch is refused by the event channel.
APP_URL = os.environ.get("APP_URL", "http://localhost:8080").rstrip("/")

#: Where to redirect after the cookie is set.
TARGET = f"{APP_URL}/home"

#: The hosts that count as the stand. A production domain is not among them.
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")

#: The handover port. Its own rather than the stand port: cookies belong to a
#: host rather than to a port, and one set here will travel to 8080 as well.
PORT = 9099


def main() -> None:
    # The stand only: issuing a session around the sign-in on a production host
    # is not acceptable, and `APP_URL` comes from the environment and may point
    # anywhere.
    if (urlsplit(APP_URL).hostname or "") not in LOCAL_HOSTS:
        print(f"APP_URL does not point at the stand: {APP_URL}", file=sys.stderr)
        raise SystemExit(1)

    if not TOKEN_FILE.exists():
        print(f"no {TOKEN_FILE.name} file: issue a session first", file=sys.stderr)
        raise SystemExit(1)

    token = TOKEN_FILE.read_text().strip()
    if not token:
        print(f"{TOKEN_FILE.name} is empty", file=sys.stderr)
        raise SystemExit(1)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 — the name comes from the base class
            self.send_response(302)
            self.send_header("Set-Cookie", f"authToken={token}; Path=/; SameSite=Lax")
            self.send_header("Location", TARGET)
            self.end_headers()

        def log_message(self, *args: object) -> None:
            """Silently: the ordinary server log writes the request line."""

    server = HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.handle_request()
    finally:
        server.server_close()


main()
