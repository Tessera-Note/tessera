"""Open a session on the local stand.

Needed for inspecting the screens by eye. An account must not be created on the
stand, and the agent does not type a password into a form: the session is issued
the same way signing in through a provider issues it —
`AuthService.open_session_for`. No password takes part here and none is checked.

Runs **inside the stand container**:

    docker cp scripts/stand-session.py tessera-v2-api:/tmp/stand-session.py
    docker exec tessera-v2-api python /tmp/stand-session.py

The token is printed to standard output and is credentials: redirect it into a
file, not into a chat and not into a log. The session is closed from the
interface by signing out or by revoking it in the account settings.

**The stand only.** The script refuses to work if `APP_URL` does not point at
the local machine: on a production host, issuing a session around the sign-in is
not acceptable.
"""

from __future__ import annotations

import asyncio
import os
import sys
from urllib.parse import urlparse

from sqlalchemy import select

from tessera_api.infrastructure.database import Database
from tessera_api.infrastructure.models import User
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.auth import AuthService
from tessera_api.services.tokens import TokenService

#: The hosts that count as the stand. A production domain is not among them.
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")


def _is_stand() -> bool:
    host = urlparse(os.environ.get("APP_URL", "")).hostname
    return host in LOCAL_HOSTS


async def main() -> None:
    if not _is_stand():
        print("APP_URL does not point at the stand: no session issued", file=sys.stderr)
        raise SystemExit(1)

    # The connection is built by the same class as in the application: the
    # string in the environment is written with another driver, and assembling
    # the engine by hand stumbles over it.
    database = Database(os.environ["DATABASE_URL"])
    try:
        async with database.session() as session:
            # The first person created: on the stand there is only one, and that
            # is the owner of the workspace.
            user = (
                await session.execute(
                    select(User)
                    .where(User.deleted_at.is_(None))
                    .order_by(User.created_at)
                    .limit(1)
                )
            ).scalar_one()
            # The service is assembled the same way as in the sign-in route. The
            # event channel is not passed: signing out needs it, issuing does
            # not.
            service = AuthService(
                session,
                UserRepo(session),
                WorkspaceRepo(session),
                TokenService(os.environ["APP_SECRET"]),
            )
            token = await service.open_session_for(
                user, user.workspace_id, user_agent="stand-review"
            )
            print(token)
    finally:
        await database.dispose()


asyncio.run(main())
