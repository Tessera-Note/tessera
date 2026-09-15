"""Вход через провайдера и синхронизация групп.

Здесь только то, что не зависит от протокола: сопоставление человека и
привязка групп. Сами протоколы (OIDC, SAML, LDAP) добавляются поверх и отдают
сюда разобранный профиль.

Правила перенесены из v1 вместе с историей: каждое стоило там разбора, и
половина — потери доступов.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import unauthorized
from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import (
    AuthAccount,
    AuthProvider,
    Group,
    GroupUser,
    User,
    Workspace,
)
from tessera_api.services.audit import ActorType, AuditEvent, AuditResource, AuditService
from tessera_api.services.auth import assert_domain_allowed

logger = logging.getLogger(__name__)


def extract_group_names(profile: dict | None, claim_name: str | None = None) -> list[str] | None:
    """Достать имена групп из профиля.

    Возвращает `None`, когда утверждения в профиле нет вовсе, и `[]`, когда оно
    есть и пустое. Это разные вещи, и в v1 их смешение стоило потери доступов:
    провайдер без нужной области видимости групп не присылает их совсем, а
    трактовка «нигде не состоит» вычищала человеку все группы каталога.
    """
    if not profile:
        return None

    claim = (claim_name or "").strip() or "groups"
    raw = profile.get(claim)
    if raw is None:
        return None

    values = raw if isinstance(raw, list) else str(raw).split(",")
    names: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        # Каталог отдаёт полное различительное имя, а привязка хранит короткое.
        if text.upper().startswith("CN="):
            text = text[3:].split(",", 1)[0].strip()
        names.append(text)
    return names


def extract_claim_value(profile: dict | None, claim_name: str | None) -> str | None:
    """Значение утверждения, которое провайдер назначил неизменным ключом.

    Строка берётся как есть, у списка — первый непустой элемент: SAML отдаёт
    атрибуты списками. Пустое значение означает «ключа нет»: сопоставление по
    пустой строке свело бы в одну запись всех, у кого атрибут не заполнен.
    """
    if not profile or not claim_name or not claim_name.strip():
        return None
    raw = profile.get(claim_name.strip())
    if isinstance(raw, list):
        raw = next((one for one in raw if one is not None and str(one).strip()), None)
    if raw is None:
        return None
    value = str(raw).strip()
    return value or None


class SsoGroupSyncService:
    """Состав групп по данным провайдера.

    Распоряжается только теми группами, которые явно привязаны к этому
    провайдеру. В v1 владение выводилось из совпадения имени, и вместе с
    бэкфиллом это вычищало людей из групп, которые администратор вёл руками.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def sync(
        self,
        *,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        provider: AuthProvider,
        group_names: list[str] | None,
    ) -> None:
        if not provider.group_sync:
            return

        # Отсутствие сведений и пустой список это разные вещи. Пустой снимает
        # членство, отсутствие не делает ничего.
        if group_names is None:
            return

        wanted = {name.strip().lower() for name in group_names if name and name.strip()}

        owned = list(
            (
                await self._session.execute(
                    select(Group)
                    .where(Group.workspace_id == workspace_id)
                    .where(Group.is_default.is_(False))
                    .where(Group.deleted_at.is_(None))
                    .where(Group.directory_source == "sso")
                    .where(Group.directory_provider_id == provider.id)
                )
            )
            .scalars()
            .all()
        )
        if not owned:
            return

        matched = {
            group.id
            for group in owned
            if group.directory_key and group.directory_key.strip().lower() in wanted
        }
        owned_ids = {group.id for group in owned}

        current = set(
            (
                await self._session.execute(
                    select(GroupUser.group_id)
                    .where(GroupUser.user_id == user_id)
                    .where(GroupUser.group_id.in_(owned_ids))
                )
            )
            .scalars()
            .all()
        )

        for group_id in matched - current:
            await self._session.execute(
                insert(GroupUser).values(id=uuid.uuid4(), user_id=user_id, group_id=group_id)
            )
        for group_id in current - matched:
            await self._session.execute(
                delete(GroupUser)
                .where(GroupUser.user_id == user_id)
                .where(GroupUser.group_id == group_id)
            )


class SsoIdentityService:
    """Сопоставление человека с записью провайдера."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._groups = SsoGroupSyncService(session)

    async def resolve(
        self,
        *,
        provider: AuthProvider,
        subject: str,
        email: str,
        name: str | None,
        workspace_id: uuid.UUID,
        group_names: list[str] | None = None,
        match_value: str | None = None,
    ) -> User:
        """Найти или завести человека по данным провайдера.

        Порядок поиска: связь по идентификатору, затем по неизменному ключу,
        если провайдер его прислал (`match_claim_name` провайдера), затем по
        почте. Ключ нужен ровно на случай, когда у провайдера сменились и
        идентификатор, и почта разом: оба прежних поиска тогда промахиваются, и
        без ключа заводилась бы вторая запись того же человека.

        Если заводится новая запись с именем уже действующего участника, это
        не отказ — это может быть тёзка, — но и не молчание: в журнал уходит
        `user.sso_possible_duplicate`, и администратор решает действием «это
        тот же человек».
        """
        if not provider.is_enabled:
            raise unauthorized("error.sso.provider_disabled")

        email = email.strip().lower()

        linked = (
            await self._session.execute(
                select(AuthAccount)
                .where(AuthAccount.auth_provider_id == provider.id)
                .where(AuthAccount.provider_user_id == subject)
                .where(AuthAccount.workspace_id == workspace_id)
                .where(AuthAccount.deleted_at.is_(None))
            )
        ).scalar_one_or_none()

        if linked is not None:
            user = await self._session.get(User, linked.user_id)
            if user is None or user.deleted_at is not None:
                raise unauthorized("error.sso.account_unavailable")
            if match_value and linked.match_claim_value != match_value:
                # Ключ дописывается к связи при обычном входе: связи, заведённые
                # до настройки сопоставления, иначе не получили бы его никогда,
                # и смена идентификатора и почты разом снова заводила бы дубль.
                await self._backfill_key(linked, provider, match_value, workspace_id)
            return await self._with_groups(user, provider, workspace_id, group_names)

        if match_value:
            keyed = (
                (
                    await self._session.execute(
                        select(AuthAccount)
                        .where(AuthAccount.auth_provider_id == provider.id)
                        .where(AuthAccount.match_claim_value == match_value)
                        .where(AuthAccount.workspace_id == workspace_id)
                        .where(AuthAccount.deleted_at.is_(None))
                        .limit(2)
                    )
                )
                .scalars()
                .all()
            )
            if len(keyed) > 1:
                # Две связи с одним ключом: какая из них этот человек, данные не
                # говорят, и выбор наугад отдал бы чужую запись.
                raise unauthorized("error.sso.identity_conflict")
            if keyed:
                return await self._relink(
                    keyed[0], provider, subject, workspace_id, group_names
                )

        existing = (
            await self._session.execute(
                select(User)
                .where(User.email == email)
                .where(User.workspace_id == workspace_id)
                .where(User.deleted_at.is_(None))
            )
        ).scalar_one_or_none()

        if existing is not None:
            # Человек уже заведён, но связи с этим провайдером нет. Если она
            # есть под другим идентификатором, совпадение по почте
            # неоднозначно: это либо смена идентификатора у того же человека,
            # либо адрес, переданный другому после увольнения. Перепривязка во
            # втором случае отдала бы чужую учётную запись.
            bound = (
                await self._session.execute(
                    select(AuthAccount)
                    .where(AuthAccount.user_id == existing.id)
                    .where(AuthAccount.auth_provider_id == provider.id)
                    .where(AuthAccount.workspace_id == workspace_id)
                    .where(AuthAccount.deleted_at.is_(None))
                )
            ).scalar_one_or_none()
            if bound is not None:
                raise unauthorized("error.sso.identity_conflict")

            await self._link(existing.id, provider.id, subject, workspace_id, match_value)
            return await self._with_groups(existing, provider, workspace_id, group_names)

        if not provider.allow_signup:
            raise unauthorized("error.sso.signup_disabled")

        # Список разрешённых доменов сужает круг и здесь: подпись настройки
        # прямо говорит про регистрацию через провайдера, и заведение в обход
        # списка сделало бы её пустой.
        workspace = await self._session.get(Workspace, workspace_id)
        assert_domain_allowed(email, workspace)

        namesakes = await self._namesakes(name, workspace_id)

        user_id = uuid.uuid4()
        await self._session.execute(
            insert(User).values(
                id=user_id,
                name=(name or email).strip(),
                email=email,
                role=UserRole.MEMBER,
                workspace_id=workspace_id,
                # Провайдер уже подтвердил личность, второе подтверждение
                # письмом ничего не добавляет и мешает войти.
                email_verified_at=datetime.now(UTC),
            )
        )
        await self._link(user_id, provider.id, subject, workspace_id, match_value)

        if namesakes:
            await AuditService(self._session).log(
                event=AuditEvent.USER_SSO_POSSIBLE_DUPLICATE,
                resource_type=AuditResource.USER,
                resource_id=user_id,
                user_id=None,
                workspace_id=workspace_id,
                actor_type=ActorType.SYSTEM,
                metadata={
                    "providerId": str(provider.id),
                    "sameNameAs": [str(one) for one in namesakes],
                },
            )

        default_group = (
            await self._session.execute(
                select(Group.id)
                .where(Group.workspace_id == workspace_id)
                .where(Group.is_default)
                .where(Group.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if default_group is not None:
            await self._session.execute(
                insert(GroupUser).values(id=uuid.uuid4(), user_id=user_id, group_id=default_group)
            )

        created = await self._session.get(User, user_id)
        return await self._with_groups(created, provider, workspace_id, group_names)

    async def _namesakes(self, name: str | None, workspace_id: uuid.UUID) -> list[uuid.UUID]:
        """Действующие участники с тем же именем, что у заводимой записи.

        Имя сравнивается без учёта регистра и крайних пробелов. Без имени
        сравнивать нечего: запись тогда заводится по почте, а совпадение по
        почте найдено бы раньше. Предел — десяток: перечень нужен журналу, а
        не разбору всех тёзок пространства.
        """
        cleaned = (name or "").strip()
        if not cleaned:
            return []
        return list(
            (
                await self._session.execute(
                    select(User.id)
                    .where(User.workspace_id == workspace_id)
                    .where(User.deleted_at.is_(None))
                    .where(User.deactivated_at.is_(None))
                    .where(func.lower(func.trim(User.name)) == cleaned.lower())
                    .limit(10)
                )
            )
            .scalars()
            .all()
        )

    async def _backfill_key(
        self,
        linked: AuthAccount,
        provider: AuthProvider,
        match_value: str,
        workspace_id: uuid.UUID,
    ) -> None:
        """Дописать ключ к связи, если он ни у кого больше не записан.

        Тот же ключ уже у другой живой связи — запись создала бы два
        одинаковых ключа, и сопоставление по нему перестало бы работать для
        обоих (две связи с одним ключом — отказ). Поэтому не пишется, а
        уходит в журнал сервера: разбирать это администратору.
        """
        taken = (
            await self._session.execute(
                select(AuthAccount.id)
                .where(AuthAccount.auth_provider_id == provider.id)
                .where(AuthAccount.match_claim_value == match_value)
                .where(AuthAccount.workspace_id == workspace_id)
                .where(AuthAccount.deleted_at.is_(None))
                .where(AuthAccount.id != linked.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if taken is not None:
            logger.warning(
                "Ключ сопоставления провайдера %s уже записан у другой связи: "
                "у связи %s не записан",
                provider.id,
                linked.id,
            )
            return
        await self._session.execute(
            update(AuthAccount)
            .where(AuthAccount.id == linked.id)
            .values(match_claim_value=match_value)
        )

    async def _relink(
        self,
        link: AuthAccount,
        provider: AuthProvider,
        subject: str,
        workspace_id: uuid.UUID,
        group_names: list[str] | None,
    ) -> User:
        """Перевесить связь на новый идентификатор по неизменному ключу.

        Ключ совпал, идентификатор — нет: провайдер сменил идентификатор
        человека. Ключ назначен администратором как неизменный и не правится
        самим человеком, поэтому совпадение по нему доказывает, что это тот же
        человек, — в отличие от совпадения по почте, которое может означать
        адрес, переданный другому. Событие в журнале отдельное: смена
        идентификатора у провайдера должна быть видна без разбора полей.
        """
        user = await self._session.get(User, link.user_id)
        if user is None or user.deleted_at is not None:
            raise unauthorized("error.sso.account_unavailable")
        await self._session.execute(
            update(AuthAccount).where(AuthAccount.id == link.id).values(provider_user_id=subject)
        )
        await AuditService(self._session).log(
            event=AuditEvent.USER_SSO_RELINKED,
            resource_type=AuditResource.USER,
            resource_id=user.id,
            user_id=None,
            workspace_id=workspace_id,
            actor_type=ActorType.SYSTEM,
            metadata={"providerId": str(provider.id)},
        )
        return await self._with_groups(user, provider, workspace_id, group_names)

    async def _link(
        self,
        user_id: uuid.UUID,
        provider_id: uuid.UUID,
        subject: str,
        workspace_id: uuid.UUID,
        match_value: str | None = None,
    ) -> None:
        """Завести связь человека с провайдером.

        Связь, снятая раньше администратором, оживляется, а не заводится
        второй строкой. Снятие мягкое — с каким провайдером был связан
        человек, ценно при разборе, — а уникальность пары «человек, провайдер»
        в базе от пометки не зависит. Вставка падала на ней, и вход после
        снятия, ради которого снятие и существует, отказывал.

        Оживляется только снятая: живая связь этой пары сюда не доходит —
        вызывающий проверяет её раньше и отвечает отказом.
        """
        revived = (
            await self._session.execute(
                update(AuthAccount)
                .where(AuthAccount.user_id == user_id)
                .where(AuthAccount.auth_provider_id == provider_id)
                .where(AuthAccount.deleted_at.isnot(None))
                .values(
                    provider_user_id=subject,
                    workspace_id=workspace_id,
                    deleted_at=None,
                    # Ключ без нового значения сохраняется: он принадлежит тому
                    # же человеку, и пустое значение стёрло бы его.
                    **({"match_claim_value": match_value} if match_value else {}),
                )
                .returning(AuthAccount.id)
            )
        ).scalar_one_or_none()
        if revived is not None:
            return
        await self._session.execute(
            insert(AuthAccount).values(
                id=uuid.uuid4(),
                user_id=user_id,
                auth_provider_id=provider_id,
                provider_user_id=subject,
                workspace_id=workspace_id,
                match_claim_value=match_value,
            )
        )

    async def _with_groups(
        self,
        user: User,
        provider: AuthProvider,
        workspace_id: uuid.UUID,
        group_names: list[str] | None,
    ) -> User:
        """Синхронизировать группы, не роняя вход.

        Человек уже подтвердил себя у провайдера, и оставлять его снаружи из-за
        недоступной группы неверно. Отказ синхронизации попадает в журнал
        сервера, а вход продолжается.

        Здесь же общая для всех путей проверка отключённости. Место выбрано
        потому, что через него проходят все три исхода сопоставления: связанный,
        найденный по почте и только что заведённый. Проверка в каждом из них по
        отдельности разошлась бы при первой же правке одного.

        **Расхождение с v1, намеренное.** Там вход через провайдера
        отключённость не проверяет: `deactivatedAt` в модуле `ee/sso` не
        встречается, и `createSessionAndToken` её тоже не смотрит. Доступа это
        не даёт — охрана запроса отсекает отключённого на каждом обращении, —
        но сессия заводится, отметка входа ставится и в журнал попадает вход,
        которого не было. Отказ на самом входе честнее: человек получает
        внятную причину вместо молчаливого отказа на следующем экране.
        """
        if user.deactivated_at is not None:
            raise unauthorized("error.auth.account_deactivated")

        try:
            await self._groups.sync(
                user_id=user.id,
                workspace_id=workspace_id,
                provider=provider,
                group_names=group_names,
            )
        except Exception:  # noqa: BLE001 — причина в журнале, вход важнее
            import logging

            logging.getLogger(__name__).exception("Синхронизация групп для %s не удалась", user.id)

        await self._session.execute(
            update(User).where(User.id == user.id).values(last_login_at=datetime.now(UTC))
        )
        await self._session.commit()
        return user
