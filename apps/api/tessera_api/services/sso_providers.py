"""Управление провайдерами входа.

Здесь только административные действия: завести, изменить, удалить, снять
связь участника. Сам вход через провайдера лежит в `services/oidc.py`,
`services/saml.py` и `services/ldap.py`, и эти маршруты открытые — эти нет.

Два правила определяют почти весь код ниже.

**Секрет наружу не отдаётся никогда.** Ни целиком, ни частью. У ключа
провайдера ИИ маска помогает опознать ключ среди нескольких, здесь опознавать
нечего: провайдер один на протокол, и его секрет либо задан, либо нет. Наружу
идёт признак заполненности.

**Пустой секрет в запросе означает «не менять», а не «стереть».** Форма не
показывает текущее значение, и сохранение формы, где секрет не трогали, иначе
обнуляло бы его — вход перестал бы работать у всех сразу.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from ldap3.operation.search import parse_filter
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import is_workspace_admin
from tessera_api.infrastructure.models import AuthAccount, AuthProvider, User, Workspace
from tessera_api.infrastructure.secrets import encrypt_secret
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService

if TYPE_CHECKING:
    from tessera_api.services.realtime import RealtimeService

#: Поля, обязательные для каждого типа провайдера.
#:
#: Проверяются здесь, а не описанием запроса: все четыре типа лежат в одной
#: таблице, и «обязательно, когда тип saml» описанием одного запроса не
#: выражается без отдельного описания на каждый тип.
REQUIRED_BY_TYPE: dict[str, tuple[str, ...]] = {
    "saml": ("saml_url", "saml_certificate"),
    "oidc": ("oidc_issuer", "oidc_client_id", "oidc_client_secret"),
    "ldap": ("ldap_url", "ldap_base_dn"),
    "google": (),
}

#: Поля, которые хранятся шифрованными и наружу не идут.
SECRET_FIELDS = ("oidc_client_secret", "ldap_bind_password")

#: Типы, у которых адреса протокола строятся от `APP_URL`.
#:
#: У OIDC это обратный адрес, у SAML ещё и идентификатор поставщика услуги,
#: который уходит в проверку получателя. LDAP и Google сюда не входят: у
#: первого обращение идёт к каталогу напрямую, у второго адрес общий.
APP_URL_DEPENDENT = ("saml", "oidc")

#: Поля, которые правит администратор. Остальные — служебные, их правит код.
EDITABLE = (
    "name",
    "is_enabled",
    "allow_signup",
    "group_sync",
    "group_claim_name",
    "match_claim_name",
    "oidc_issuer",
    "oidc_client_id",
    "oidc_client_secret",
    "saml_url",
    "saml_certificate",
    "ldap_url",
    "ldap_base_dn",
    "ldap_bind_dn",
    "ldap_bind_password",
    "ldap_user_search_filter",
    "ldap_user_attributes",
    "ldap_tls_enabled",
    "ldap_tls_ca_cert",
)

#: Имя поля наружу. Схема на змеиной записи, клиент говорит на верблюжьей.
_OUT = {
    "id": "id",
    "name": "name",
    "type": "type",
    "workspace_id": "workspaceId",
    "creator_id": "creatorId",
    "is_enabled": "isEnabled",
    "allow_signup": "allowSignup",
    "group_sync": "groupSync",
    "group_claim_name": "groupClaimName",
    "match_claim_name": "matchClaimName",
    "oidc_issuer": "oidcIssuer",
    "oidc_client_id": "oidcClientId",
    "saml_url": "samlUrl",
    "saml_certificate": "samlCertificate",
    "ldap_url": "ldapUrl",
    "ldap_base_dn": "ldapBaseDn",
    "ldap_bind_dn": "ldapBindDn",
    "ldap_user_search_filter": "ldapUserSearchFilter",
    "ldap_user_attributes": "ldapUserAttributes",
    "ldap_tls_enabled": "ldapTlsEnabled",
    "ldap_tls_ca_cert": "ldapTlsCaCert",
    "created_at": "createdAt",
    "updated_at": "updatedAt",
}

MAX_NAME = 255


def public_view(provider: AuthProvider) -> dict[str, Any]:
    """Провайдер в виде, пригодном для выдачи наружу."""
    view: dict[str, Any] = {
        outer: getattr(provider, inner, None) for inner, outer in _OUT.items()
    }
    view["oidcClientSecretSet"] = bool(provider.oidc_client_secret)
    view["ldapBindPasswordSet"] = bool(provider.ldap_bind_password)
    return view


def _normalize(url: str) -> str:
    return url.strip().rstrip("/").lower()


class SsoProviderService:
    def __init__(self, session: AsyncSession, *, app_secret: str, app_url: str) -> None:
        self._session = session
        self._app_secret = app_secret
        self._app_url = app_url
        self._audit = AuditService(session)

    # --- проверки ---------------------------------------------------------

    def _assert_can_manage(self, actor: User) -> None:
        """Провайдерами входа распоряжается администратор пространства.

        Право то же, что у прочих настроек безопасности: расхождение внутри
        одного экрана означало бы, что часть его действий отказывает без
        объяснимой для человека причины.
        """
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

    def _assert_required(self, provider_type: str, values: dict[str, Any]) -> None:
        required = REQUIRED_BY_TYPE.get(provider_type)
        if required is None:
            raise bad_request("error.sso.provider_type_unknown")
        missing = [field for field in required if not values.get(field)]
        if missing:
            raise bad_request(
                "error.sso.provider_fields_required",
                {"type": provider_type, "fields": ", ".join(missing)},
            )

    def _assert_ldap(self, values: dict[str, Any]) -> None:
        """Проверки, свойственные каталогу.

        Обе ловят ошибку настройки при сохранении, а не на первом входе, когда
        разбираться придётся по журналу.
        """
        url = str(values.get("ldap_url") or "")
        # `ldaps://` шифрует соединение с первого байта, StartTLS же это
        # расширенная операция поверх открытого `ldap://`. Вместе они
        # бессмысленны: вызов StartTLS на зашифрованном соединении отвергает
        # сам каталог.
        if url.lower().startswith("ldaps://") and values.get("ldap_tls_enabled"):
            raise bad_request("error.sso.ldaps_starttls_conflict")

        template = values.get("ldap_user_search_filter")
        if isinstance(template, str) and template.strip():
            probe = template.replace("{username}", "\\d0\\bf\\d1\\80")
            try:
                parse_filter(probe, None, False, False, None, False)
            except Exception as failure:
                raise bad_request("error.sso.filter_invalid") from failure

    def _app_url_mismatch(self, provider_type: str, origin: str | None) -> dict | None:
        """Сверка `APP_URL` с адресом, по которому открыт интерфейс.

        Адреса протокола сервер строит от `APP_URL`, а значения для копирования
        в провайдера экран показывает от адреса открытой страницы. Разойдясь,
        они дают отказ на каждом входе без внятной причины, и поймать это при
        настройке дешевле, чем потом по журналу.

        Это предупреждение, а не запрет: за обратным прокси адрес интерфейса
        может законно отличаться от того, что видит сервер.
        """
        if provider_type not in APP_URL_DEPENDENT or not origin:
            return None
        if _normalize(self._app_url) == _normalize(origin):
            return None
        return {"appUrl": self._app_url, "origin": origin}

    # --- чтение -----------------------------------------------------------

    async def list(self, actor: User, workspace: Workspace) -> dict[str, Any]:
        self._assert_can_manage(actor)
        rows = (
            (
                await self._session.execute(
                    select(AuthProvider)
                    .where(
                        AuthProvider.workspace_id == workspace.id,
                        AuthProvider.deleted_at.is_(None),
                    )
                    .order_by(AuthProvider.created_at.asc())
                )
            )
            .scalars()
            .all()
        )
        items = [public_view(one) for one in rows]
        return {
            "items": items,
            "meta": {"limit": len(items), "hasNextPage": False, "hasPrevPage": False},
        }

    async def _own(self, provider_id: uuid.UUID, workspace: Workspace) -> AuthProvider:
        found = await self._session.get(AuthProvider, provider_id)
        if (
            found is None
            or found.deleted_at is not None
            or found.workspace_id != workspace.id
        ):
            raise not_found("error.sso.provider_not_found")
        return found

    async def info(
        self, provider_id: uuid.UUID, actor: User, workspace: Workspace
    ) -> dict[str, Any]:
        self._assert_can_manage(actor)
        return public_view(await self._own(provider_id, workspace))

    # --- запись -----------------------------------------------------------

    def _encrypted(self, values: dict[str, Any]) -> dict[str, Any]:
        result = dict(values)
        for field in SECRET_FIELDS:
            current = result.get(field)
            if isinstance(current, str) and current:
                result[field] = encrypt_secret(current, self._app_secret)
        return result

    async def create(
        self,
        actor: User,
        workspace: Workspace,
        values: dict[str, Any],
        *,
        origin: str | None = None,
        ip: str | None = None,
    ) -> dict[str, Any]:
        """Завести провайдера.

        Новый провайдер по умолчанию **выключен**. Включать его следует после
        проверки настроек: ошибка в адресе или сертификате у включённого сразу
        перекрывает вход всем, кто ходит через этого провайдера.
        """
        self._assert_can_manage(actor)

        provider_type = str(values.get("type") or "").strip().lower()
        name = str(values.get("name") or "").strip()
        if not name or len(name) > MAX_NAME:
            raise bad_request("error.sso.provider_name_invalid", {"limit": MAX_NAME})

        fields = {key: values[key] for key in EDITABLE if key in values}
        self._assert_required(provider_type, fields)
        if provider_type == "ldap":
            self._assert_ldap(fields)

        provider_id = uuid.uuid4()
        row = {
            "id": provider_id,
            "name": name,
            "type": provider_type,
            "workspace_id": workspace.id,
            "creator_id": actor.id,
            "is_enabled": bool(fields.get("is_enabled", False)),
            "allow_signup": bool(fields.get("allow_signup", False)),
            "group_sync": bool(fields.get("group_sync", False)),
            "group_claim_name": fields.get("group_claim_name") or None,
            "match_claim_name": fields.get("match_claim_name") or None,
        }
        for field in EDITABLE:
            if field not in row and field in fields:
                row[field] = fields[field]

        await self._session.execute(insert(AuthProvider).values(**self._encrypted(row)))
        await self._audit.log(
            event=AuditEvent.SSO_PROVIDER_CREATED,
            resource_type=AuditResource.SSO_PROVIDER,
            resource_id=provider_id,
            user_id=actor.id,
            workspace_id=workspace.id,
            ip=ip,
            metadata={"type": provider_type},
        )
        await self._session.commit()

        created = await self._own(provider_id, workspace)
        return {
            **public_view(created),
            "appUrlMismatch": self._app_url_mismatch(provider_type, origin),
        }

    async def update(
        self,
        provider_id: uuid.UUID,
        actor: User,
        workspace: Workspace,
        values: dict[str, Any],
        *,
        origin: str | None = None,
        ip: str | None = None,
    ) -> dict[str, Any]:
        self._assert_can_manage(actor)
        existing = await self._own(provider_id, workspace)

        patch: dict[str, Any] = {}
        for field in EDITABLE:
            if field not in values:
                continue
            given = values[field]
            if given is None:
                continue
            if field in SECRET_FIELDS and given == "":
                continue
            patch[field] = given

        if "match_claim_name" in patch:
            # Пустая строка — «ключа нет», как при заведении.
            patch["match_claim_name"] = str(patch["match_claim_name"]).strip() or None
        claim_changed = (
            "match_claim_name" in patch
            and patch["match_claim_name"] != (existing.match_claim_name or None)
        )

        if "name" in patch:
            name = str(patch["name"]).strip()
            if not name or len(name) > MAX_NAME:
                raise bad_request("error.sso.provider_name_invalid", {"limit": MAX_NAME})
            patch["name"] = name

        if not patch:
            return {
                **public_view(existing),
                "appUrlMismatch": self._app_url_mismatch(existing.type, origin),
            }

        # Тип не меняется. Поля разных типов не пересекаются, и смена типа
        # оставила бы провайдера с заполненными полями прежнего протокола.
        merged = {field: getattr(existing, field, None) for field in EDITABLE}
        merged.update(patch)
        self._assert_required(existing.type, merged)
        if existing.type == "ldap":
            self._assert_ldap(merged)

        await self._session.execute(
            update(AuthProvider)
            .where(AuthProvider.id == provider_id)
            .values(**self._encrypted(patch), updated_at=datetime.now(UTC))
        )
        if claim_changed:
            # Значения прежнего утверждения под новым ничего не значат, а совпав
            # случайно со значением нового у другого человека, перевесили бы
            # его вход на чужую запись. Снимаются все: при следующем входе по
            # связи каждая получит значение нового утверждения.
            await self._session.execute(
                update(AuthAccount)
                .where(AuthAccount.auth_provider_id == provider_id)
                .values(match_claim_value=None)
            )
        await self._audit.log(
            event=AuditEvent.SSO_PROVIDER_UPDATED,
            resource_type=AuditResource.SSO_PROVIDER,
            resource_id=provider_id,
            user_id=actor.id,
            workspace_id=workspace.id,
            ip=ip,
            changes={"fields": sorted(patch)},
        )
        await self._session.commit()

        changed = await self._own(provider_id, workspace)
        return {
            **public_view(changed),
            "appUrlMismatch": self._app_url_mismatch(existing.type, origin),
        }

    async def delete(
        self,
        provider_id: uuid.UUID,
        actor: User,
        workspace: Workspace,
        *,
        ip: str | None = None,
    ) -> None:
        """Удалить провайдера.

        Удаление мягкое, и это не осторожность ради осторожности: на провайдера
        ссылаются связи учётных записей, и физическое удаление оставило бы их
        указывающими в пустоту — разобрать, откуда пришёл человек, стало бы
        нечем. Заодно провайдер выключается: удалённый, но включённый остался
        бы виден на странице входа.
        """
        self._assert_can_manage(actor)
        await self._own(provider_id, workspace)

        await self._session.execute(
            update(AuthProvider)
            .where(
                AuthProvider.id == provider_id,
                AuthProvider.workspace_id == workspace.id,
                AuthProvider.deleted_at.is_(None),
            )
            .values(deleted_at=datetime.now(UTC), is_enabled=False)
        )
        await self._audit.log(
            event=AuditEvent.SSO_PROVIDER_DELETED,
            resource_type=AuditResource.SSO_PROVIDER,
            resource_id=provider_id,
            user_id=actor.id,
            workspace_id=workspace.id,
            ip=ip,
        )
        await self._session.commit()

    async def merge_duplicate(
        self,
        source_user_id: uuid.UUID,
        target_user_id: uuid.UUID,
        actor: User,
        workspace: Workspace,
        *,
        ip: str | None = None,
        realtime: RealtimeService | None = None,
    ) -> dict[str, Any]:
        """Свести запись-дубль с прежней: «это тот же человек».

        Вход через провайдера, у которого сменились и идентификатор, и почта,
        заводит вторую запись: отличить её от нового сотрудника данным нечем.
        Журнал отмечает такую запись событием `user.sso_possible_duplicate`, а
        решение остаётся за администратором.

        Связи дубля с провайдерами переходят к прежней записи — следующий вход
        находит её уже по связи, — а дубль отключается тем же путём, что и
        ручное отключение: с отзывом сеансов и событием в журнале. Удаления
        нет: сделанное под дублем остаётся с автором.

        Прежняя связь той же записи с тем же провайдером, если была (живая или
        снятая), получает идентификатор дубля и оживает: уникальность пары
        «человек, провайдер» не даёт завести вторую строку.
        """
        from tessera_api.services.workspace import WorkspaceService

        self._assert_can_manage(actor)
        if source_user_id == target_user_id:
            raise bad_request("error.sso.merge_same_person")

        source = await self._session.get(User, source_user_id)
        if (
            source is None
            or source.workspace_id != workspace.id
            or source.deleted_at is not None
        ):
            raise bad_request("error.sso.user_not_found")

        target = await self._session.get(User, target_user_id)
        if (
            target is None
            or target.workspace_id != workspace.id
            or target.deleted_at is not None
            or target.deactivated_at is not None
        ):
            # Связи уходят к записи, которой пользоваться нельзя: вход после
            # сведения упёрся бы в отключённого, и человек остался бы без входа.
            raise bad_request("error.sso.merge_target_unavailable")

        links = list(
            (
                await self._session.execute(
                    select(AuthAccount).where(
                        AuthAccount.user_id == source.id,
                        AuthAccount.workspace_id == workspace.id,
                        AuthAccount.deleted_at.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        if not links:
            raise bad_request("error.sso.user_has_no_links")

        now = datetime.now(UTC)
        for link in links:
            if link.auth_provider_id is None:
                # Связь без провайдера уникальностью пары не ограничена: сравнение
                # с пустым провайдером нашло бы чужие такие же строки. Она просто
                # переходит к прежней записи.
                await self._session.execute(
                    update(AuthAccount).where(AuthAccount.id == link.id).values(user_id=target.id)
                )
                continue
            previous = (
                await self._session.execute(
                    select(AuthAccount).where(
                        AuthAccount.user_id == target.id,
                        AuthAccount.auth_provider_id == link.auth_provider_id,
                    )
                )
            ).scalar_one_or_none()
            if previous is None:
                await self._session.execute(
                    update(AuthAccount).where(AuthAccount.id == link.id).values(user_id=target.id)
                )
                continue
            await self._session.execute(
                update(AuthAccount).where(AuthAccount.id == link.id).values(deleted_at=now)
            )
            revived: dict[str, Any] = {
                "provider_user_id": link.provider_user_id,
                "deleted_at": None,
            }
            if link.match_claim_value:
                # Ключ дубля — свежий, он и остаётся. Без ключа у дубля прежний
                # не затирается пустым: он принадлежит тому же человеку.
                revived["match_claim_value"] = link.match_claim_value
            await self._session.execute(
                update(AuthAccount).where(AuthAccount.id == previous.id).values(**revived)
            )

        await self._audit.log(
            event=AuditEvent.USER_SSO_MERGED,
            resource_type=AuditResource.USER,
            resource_id=target.id,
            user_id=actor.id,
            workspace_id=workspace.id,
            ip=ip,
            metadata={"from": str(source.id), "links": len(links)},
        )
        # Отключение фиксирует и перенос связей: одна транзакция на всё.
        await WorkspaceService(self._session, realtime).set_active(
            actor, source.id, False, workspace.id
        )
        return {"success": True, "moved": len(links)}

    async def unlink_user(
        self,
        target_user_id: uuid.UUID,
        actor: User,
        workspace: Workspace,
        *,
        ip: str | None = None,
    ) -> dict[str, Any]:
        """Снять связи участника с провайдерами входа.

        Нужно, когда провайдер сменил идентификатор человека. Вход в этом
        случае отвергается намеренно: совпадение по почте при уже существующей
        связи неотличимо от адреса, переданного другому человеку, и
        перепривязка отдала бы чужую учётную запись. Разорвать связь может
        только администратор, после чего следующий вход заводит её заново.

        Удаление мягкое: с каким провайдером был связан человек, ценно при
        разборе происшествий, а повторная привязка снимает пометку.
        """
        self._assert_can_manage(actor)

        target = await self._session.get(User, target_user_id)
        if (
            target is None
            or target.workspace_id != workspace.id
            or target.deleted_at is not None
        ):
            raise bad_request("error.sso.user_not_found")

        rows = (
            (
                await self._session.execute(
                    select(AuthAccount.id).where(
                        AuthAccount.user_id == target.id,
                        AuthAccount.workspace_id == workspace.id,
                        AuthAccount.deleted_at.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        if not rows:
            raise bad_request("error.sso.user_has_no_links")

        await self._session.execute(
            update(AuthAccount)
            .where(AuthAccount.id.in_(rows))
            .values(deleted_at=datetime.now(UTC))
        )
        # Событие отдельное, а не общее «изменён участник»: снятие чужой связи
        # с провайдером должно быть различимо в журнале без разбора полей.
        await self._audit.log(
            event=AuditEvent.USER_SSO_UNLINKED,
            resource_type=AuditResource.USER,
            resource_id=target.id,
            user_id=actor.id,
            workspace_id=workspace.id,
            ip=ip,
            metadata={"unlinked": len(rows)},
        )
        await self._session.commit()
        return {"success": True, "unlinked": len(rows)}
