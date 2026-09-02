"""Отображение существующих таблиц.

Схема принадлежит базе: v2 подключается к той же, что и v1, и не пересобирает
её. Поэтому модели описывают то, что есть, а не то, как было бы удобнее.
Расхождение модели с таблицей проявится не отказом, а неверными данными,
поэтому имена и обнуляемость взяты из снимка `schema/schema.hcl`.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    DateTime,
    Integer,
    LargeBinary,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Общий предок моделей."""


#: JSONB для колонок, где пустота допустима.
#:
#: Без `none_as_null` пустое значение уезжает в колонку как JSON-«null», то есть
#: как значение, а не как его отсутствие. Разница не косметическая: у колонок
#: базы стоит ограничение «объект или ничего», и JSON-«null» его нарушает — а
#: там, где ограничения нет, отбор `IS NULL` молча перестаёт находить такие
#: строки.
NullableJsonb = JSONB(none_as_null=True)


class CreatedMixin:
    """Только отметка создания.

    Набор отметок в таблицах v1 разный, и общая примесь на все таблицы
    приписала бы колонки, которых в базе нет. Проверено сверкой моделей с
    рабочей базой: `group_users`, `user_sessions`, `audit` и
    `workspace_invitations` не имеют части этих колонок.
    """

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TimestampMixin(CreatedMixin):
    """Создание и изменение."""

    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SoftDeleteMixin(TimestampMixin):
    """Создание, изменение и мягкое удаление."""

    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class User(Base, SoftDeleteMixin):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    email: Mapped[str] = mapped_column(String)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Пароля нет у того, кто заведён через провайдера входа. Это не признак
    # поломки, а обычное состояние: вход у него идёт другим путём.
    password: Mapped[str | None] = mapped_column(String)
    avatar_url: Mapped[str | None] = mapped_column(String)
    role: Mapped[str | None] = mapped_column(String)
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    invited_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    locale: Mapped[str | None] = mapped_column(String)
    timezone: Mapped[str | None] = mapped_column(String)
    settings: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Связь записи с каталогом. Единственная: по ней провайдер узнаёт своего
    # человека, и потеряв её, он заведёт его заново как нового сотрудника.
    scim_external_id: Mapped[str | None] = mapped_column(Text)
    # Пароль поставлен приложением, а не выбран человеком. У заведённых
    # каталогом он случайный: вход им идёт через провайдера, а колонка пустого
    # значения не допускает.
    has_generated_password: Mapped[bool] = mapped_column(Boolean)


class Workspace(Base, SoftDeleteMixin):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(String)
    logo: Mapped[str | None] = mapped_column(String)
    hostname: Mapped[str | None] = mapped_column(String)
    custom_domain: Mapped[str | None] = mapped_column(String)
    settings: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    default_space_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status: Mapped[str | None] = mapped_column(String)
    plan: Mapped[str | None] = mapped_column(String)
    # Через сколько дней страница из корзины удаляется насовсем. Описана
    # здесь потому, что на неё опирается периодическая уборка: пропажа
    # колонки обязана ронять сверку схемы, а не запрос уборки в рантайме.
    trash_retention_days: Mapped[int | None] = mapped_column(BigInteger)
    # Требовать второй фактор со всех. Описан здесь потому, что на него
    # опирается вход: пропажа колонки обязана ронять сверку схемы.
    enforce_mfa: Mapped[bool | None] = mapped_column(Boolean)
    # Синхронизация каталога включается одним переключателем. Описан здесь
    # потому, что на него опирается охрана SCIM: выключенная синхронизация
    # означает отказ независимо от предъявленного токена.
    is_scim_enabled: Mapped[bool | None] = mapped_column(Boolean)
    # Требовать вход только через провайдера. Описан здесь потому, что на него
    # опирается парольный вход: пропажа колонки обязана ронять сверку схемы, а
    # не открывать вход паролем в пространстве, где его запретили.
    enforce_sso: Mapped[bool | None] = mapped_column(Boolean)
    # Сколько дней хранить журнал аудита. Ноль и пустое значение означают
    # «хранить вечно»: уборка отсекает и то и другое одним условием.
    audit_retention_days: Mapped[int | None] = mapped_column(BigInteger)


class Space(Base, SoftDeleteMixin):
    __tablename__ = "spaces"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(Text)
    slug: Mapped[str] = mapped_column(String)
    logo: Mapped[str | None] = mapped_column(String)
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    settings: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    # Личное пространство. У человека оно одно: частичный уникальный индекс по
    # `creator_id` держит это правило в базе, а не в приложении.
    is_personal: Mapped[bool] = mapped_column(Boolean, server_default="false")


class SpaceMember(Base, SoftDeleteMixin):
    __tablename__ = "space_members"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    # Участником пространства бывает и человек, и группа: заполнено ровно одно
    # из двух полей. Проверка этого правила живёт в базе, а не здесь.
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    group_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    role: Mapped[str] = mapped_column(String)
    added_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class Group(Base, SoftDeleteMixin):
    __tablename__ = "groups"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(Boolean)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Привязка к каталогу: источник, провайдер и ключ. Заведена в v1 после
    # потери доступов, когда владение выводилось из совпадения имени.
    directory_source: Mapped[str | None] = mapped_column(String(10))
    directory_provider_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    directory_key: Mapped[str | None] = mapped_column(Text)
    # Связь группы с каталогом и признак, что состав ведёт он, а не человек.
    scim_external_id: Mapped[str | None] = mapped_column(Text)
    is_external: Mapped[bool] = mapped_column(Boolean)


class GroupUser(Base, TimestampMixin):
    __tablename__ = "group_users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class UserSession(Base, CreatedMixin):
    __tablename__ = "user_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    device_name: Mapped[str | None] = mapped_column(String)
    user_agent: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Проставляется умолчанием базы. Описана здесь потому, что на неё опирается
    # обрезка лишних сессий: пропажа колонки обязана ронять сверку схемы, а не
    # запрос уборки в рантайме.
    last_active_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AuthAccount(Base, SoftDeleteMixin):
    __tablename__ = "auth_accounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    provider_user_id: Mapped[str] = mapped_column(String)
    auth_provider_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class AuditLog(Base, CreatedMixin):
    """Журнал аудита.

    Таблица называется `audit`, а поля `actor_id` и `changes`: имена взяты из
    снимка схемы. Догадка здесь дала бы модель, которая собирается и молча
    пишет не туда.
    """

    __tablename__ = "audit"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    event: Mapped[str] = mapped_column(String)
    resource_type: Mapped[str] = mapped_column(String)
    resource_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Кто именно: человек, сама система или ключ API. Без этой колонки действия
    # синхронизации каталога неотличимы от действий администратора, и вопрос
    # «кто снял человека с доступа» остаётся без ответа.
    actor_type: Mapped[str] = mapped_column(String, server_default="'user'")
    changes: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    # Подробности события. В отличие от `changes` пишутся дословно, поэтому
    # класть сюда содержимое страниц нельзя: журнал читает администратор
    # пространства, которому сама страница может быть закрыта.
    event_metadata: Mapped[dict[str, Any] | None] = mapped_column("metadata", NullableJsonb)
    ip_address: Mapped[str | None] = mapped_column(INET)


class WorkspaceInvitation(Base, TimestampMixin):
    __tablename__ = "workspace_invitations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    email: Mapped[str | None] = mapped_column(String)
    role: Mapped[str] = mapped_column(String)
    token: Mapped[str] = mapped_column(String)
    group_ids: Mapped[list[uuid.UUID] | None] = mapped_column(ARRAY(UUID(as_uuid=True)))
    invited_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class UserToken(Base, CreatedMixin):
    """Одноразовый токен: сброс пароля, подтверждение почты.

    Срок и признак использования здесь, а не в самом токене: токен, который
    нельзя отозвать, действует до истечения срока даже после того, как им
    воспользовались.
    """

    __tablename__ = "user_tokens"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    token: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuthProvider(Base, SoftDeleteMixin):
    """Провайдер входа: OIDC, SAML, LDAP, Google."""

    __tablename__ = "auth_providers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(Text)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    is_enabled: Mapped[bool] = mapped_column(Boolean)
    allow_signup: Mapped[bool] = mapped_column(Boolean)
    group_sync: Mapped[bool] = mapped_column(Boolean)
    group_claim_name: Mapped[str | None] = mapped_column(String)
    oidc_issuer: Mapped[str | None] = mapped_column(String)
    oidc_client_id: Mapped[str | None] = mapped_column(String)
    oidc_client_secret: Mapped[str | None] = mapped_column(String)
    saml_url: Mapped[str | None] = mapped_column(String)
    saml_certificate: Mapped[str | None] = mapped_column(String)
    ldap_url: Mapped[str | None] = mapped_column(String)
    ldap_base_dn: Mapped[str | None] = mapped_column(String)
    ldap_bind_dn: Mapped[str | None] = mapped_column(String)
    ldap_bind_password: Mapped[str | None] = mapped_column(String)
    ldap_user_search_filter: Mapped[str | None] = mapped_column(String)
    ldap_user_attributes: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    ldap_tls_enabled: Mapped[bool | None] = mapped_column(Boolean)
    ldap_tls_ca_cert: Mapped[str | None] = mapped_column(Text)


class WorkspaceAiSettings(Base, TimestampMixin):
    """Настройки ИИ рабочего пространства.

    Ровно одна строка на пространство: уникальность `workspace_id` и есть
    механизм идемпотентности при сохранении.

    Ключи провайдеров хранятся зашифрованными. Наружу отдаётся только маска, и
    ни один путь не возвращает ключ целиком.
    """

    __tablename__ = "workspace_ai_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    driver: Mapped[str | None] = mapped_column(String)
    base_url: Mapped[str | None] = mapped_column(String)
    api_key_encrypted: Mapped[str | None] = mapped_column(Text)
    chat_model: Mapped[str | None] = mapped_column(String)
    completion_model: Mapped[str | None] = mapped_column(String)
    # Пустой провайдер эмбеддингов означает «тот же, что у чата». Это не то же
    # самое, что «эмбеддингов нет»: у большинства пространств провайдер один, и
    # заставлять выбирать его дважды незачем.
    embedding_driver: Mapped[str | None] = mapped_column(String)
    embedding_base_url: Mapped[str | None] = mapped_column(String)
    embedding_api_key_encrypted: Mapped[str | None] = mapped_column(Text)
    embedding_model: Mapped[str | None] = mapped_column(String)
    web_search_driver: Mapped[str | None] = mapped_column(String)
    web_search_base_url: Mapped[str | None] = mapped_column(String)
    web_search_api_key_encrypted: Mapped[str | None] = mapped_column(Text)


class Page(Base, SoftDeleteMixin):
    """Страница.

    `content` это документ редактора в JSON, `ydoc` — то же состояние в
    двоичном виде совместного редактирования, `text_content` — плоский текст
    для поиска. Все три обязаны меняться вместе: правка одного JSON вернётся
    назад при следующем открытии страницы.
    """

    __tablename__ = "pages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    slug_id: Mapped[str] = mapped_column(String)
    title: Mapped[str | None] = mapped_column(String)
    icon: Mapped[str | None] = mapped_column(String)
    cover_photo: Mapped[str | None] = mapped_column(String)
    position: Mapped[str | None] = mapped_column(String)
    content: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    text_content: Mapped[str | None] = mapped_column(Text)
    # Двоичное состояние совместного редактирования. Хранится рядом с JSON, а
    # не вместо него: из JSON поиск и выгрузка читают напрямую, а состояние
    # несёт историю правок, без которой открытые вкладки теряют позиции.
    ydoc: Mapped[bytes | None] = mapped_column(LargeBinary)
    # Кто правил страницу. Пополняется совместным редактированием и служит
    # источником подписчиков для ленты обновлений.
    contributor_ids: Mapped[list[uuid.UUID] | None] = mapped_column(ARRAY(UUID(as_uuid=True)))
    parent_page_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    last_updated_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    deleted_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    # Страница может быть встроенной базой. Описан здесь потому, что на него
    # опирается канал событий: подписка на комнату базы разрешается только для
    # страницы-базы, и пропажа колонки обязана ронять сверку схемы, а не
    # открывать подписку на любую страницу.
    #
    # Значение по умолчанию описано как серверное, потому что оно и есть
    # серверное (`default = false` в схеме). Без этого описания ORM считает
    # колонку обязательной и на создании обычной страницы шлёт в неё NULL —
    # то есть роняет создание страниц целиком.
    is_base: Mapped[bool] = mapped_column(Boolean, server_default="false")
    # Версия схемы базы. Клиент при подписке сверяет её с той, под которой
    # построен его кеш, и по расхождению перезапрашивает состав свойств.
    base_schema_version: Mapped[int] = mapped_column(Integer, server_default="0")


class BaseProperty(Base, SoftDeleteMixin):
    """Колонка базы.

    Идентификатор уникален только внутри страницы: первичный ключ составной.
    Восемь шестнадцатеричных знаков, потому что этот идентификатор становится
    ключом в объекте ячеек каждой строки, и длинный раздувал бы каждую строку.
    """

    __tablename__ = "base_properties"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)
    position: Mapped[str] = mapped_column(String)
    type_options: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    is_primary: Mapped[bool] = mapped_column(Boolean, server_default="false")
    schema_version: Mapped[int] = mapped_column(Integer, server_default="1")
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class BaseRow(Base, SoftDeleteMixin):
    """Строка базы.

    Все ячейки — один объект jsonb, ключ равен идентификатору свойства.
    Частичное изменение делает база одним запросом: чтение, слияние и запись
    целиком затирали бы правки соседа.
    """

    __tablename__ = "base_rows"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    cells: Mapped[dict[str, Any]] = mapped_column(JSONB)
    position: Mapped[str] = mapped_column(String)
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    last_updated_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class BaseView(Base, TimestampMixin):
    """Представление базы: таблица, доска или календарь.

    Мягкого удаления у него нет намеренно: представление это настройка показа,
    а не данные, и удалённое незачем хранить.
    """

    __tablename__ = "base_views"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    name: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String, server_default="'table'")
    position: Mapped[str] = mapped_column(String)
    config: Mapped[dict[str, Any]] = mapped_column(JSONB)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class FileTask(Base, SoftDeleteMixin):
    """Отложенная работа с файлом: ввоз архива или выгрузка.

    Строка нужна не ради учёта, а ради опроса: клиент по ней узнаёт, чем
    кончилось дело. Поэтому отказ хранится текстом здесь же — иначе человек
    видит «не получилось» без причины и приходит спрашивать.
    """

    __tablename__ = "file_tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    type: Mapped[str | None] = mapped_column(String)
    source: Mapped[str | None] = mapped_column(String)
    status: Mapped[str | None] = mapped_column(String)
    file_name: Mapped[str] = mapped_column(String)
    file_path: Mapped[str] = mapped_column(String)
    file_size: Mapped[int | None] = mapped_column(BigInteger)
    file_ext: Mapped[str | None] = mapped_column(String)
    error_message: Mapped[str | None] = mapped_column(String)
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    page_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    task_metadata: Mapped[dict[str, Any] | None] = mapped_column("metadata", NullableJsonb)


class AiChat(Base, SoftDeleteMixin):
    """Беседа с агентом.

    Принадлежит ровно одному человеку. Признака общего доступа нет ни в схеме,
    ни в коде, и заводить его нельзя: в беседе оседает содержимое страниц, к
    которым доступ есть у создателя и может не быть у другого участника
    пространства.
    """

    __tablename__ = "ai_chats"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    creator_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    title: Mapped[str | None] = mapped_column(String)


class AiChatMessage(Base, SoftDeleteMixin):
    """Реплика беседы.

    `metadata` у ответа агента хранит план необратимых действий, ожидающий
    решения человека. Именно в базе, а не в памяти процесса: подтвердить план
    можно после перезагрузки страницы, с другого устройства и через час.
    """

    __tablename__ = "ai_chat_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    chat_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    role: Mapped[str] = mapped_column(String)
    content: Mapped[str | None] = mapped_column(Text)
    tool_calls: Mapped[list[Any] | None] = mapped_column(NullableJsonb)
    message_metadata: Mapped[dict[str, Any] | None] = mapped_column("metadata", NullableJsonb)


class PageEmbedding(Base, SoftDeleteMixin):
    """Вектор куска страницы.

    Сам вектор здесь не отображён: `vector(1536)` — тип расширения, и
    SQLAlchemy без отдельной зависимости его не знает. Работа с ним идёт сырым
    SQL с приведением `::vector`, а модель нужна ради остальных колонок и ради
    сверки со снимком схемы.

    Тройка `driver`, `base_url`, `model_name` — идентичность векторного
    пространства. Выдача фильтруется по ней, поэтому смена любой составляющей
    превращает уже посчитанные строки в невидимый мусор.
    """

    __tablename__ = "page_embeddings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    attachment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    model_name: Mapped[str] = mapped_column(String)
    model_dimensions: Mapped[int] = mapped_column(Integer)
    driver: Mapped[str | None] = mapped_column(String)
    base_url: Mapped[str | None] = mapped_column(String)
    chunk_index: Mapped[int] = mapped_column(Integer)
    chunk_start: Mapped[int | None] = mapped_column(Integer)
    chunk_length: Mapped[int | None] = mapped_column(Integer)
    chunk_metadata: Mapped[dict[str, Any] | None] = mapped_column("metadata", NullableJsonb)


class PageAccess(Base, TimestampMixin):
    """Отметка о том, что доступ к странице ограничен."""

    __tablename__ = "page_access"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    access_level: Mapped[str] = mapped_column(String)
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class PagePermission(Base, TimestampMixin):
    """Кому открыта страница с ограниченным доступом."""

    __tablename__ = "page_permissions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    page_access_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    group_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    role: Mapped[str] = mapped_column(String)
    added_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class Comment(Base, SoftDeleteMixin):
    __tablename__ = "comments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    content: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    selection: Mapped[str | None] = mapped_column(String)
    type: Mapped[str | None] = mapped_column(String)
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    parent_comment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    last_edited_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class Attachment(Base, SoftDeleteMixin):
    __tablename__ = "attachments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    file_name: Mapped[str] = mapped_column(String)
    file_path: Mapped[str] = mapped_column(String)
    file_size: Mapped[int | None] = mapped_column(BigInteger)
    file_ext: Mapped[str] = mapped_column(String)
    mime_type: Mapped[str | None] = mapped_column(String)
    type: Mapped[str | None] = mapped_column(String)
    creator_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    page_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    text_content: Mapped[str | None] = mapped_column(Text)
    # Состояние разбора: не обработано, разобрано, разбору не подлежит. Третье
    # значение обязательно — без него пустой текст неотличим от ещё не
    # дошедшего до разбора, и повторный проход бесконечно перебирал бы одни и
    # те же картинки.
    index_status: Mapped[str] = mapped_column(String, server_default="'not_processed'")
    # Вложение может принадлежать беседе с ИИ, а не странице.
    ai_chat_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class Label(Base, TimestampMixin):
    __tablename__ = "labels"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(String)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class PageLabel(Base, CreatedMixin):
    __tablename__ = "page_labels"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    label_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class Favorite(Base, CreatedMixin):
    __tablename__ = "favorites"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    page_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    template_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    type: Mapped[str] = mapped_column(String)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class PageTransclusion(Base, TimestampMixin):
    """Снимок содержимого блока, на который ссылаются другие страницы.

    Хранится отдельно от самой страницы намеренно: ссылающейся странице нужен
    именно этот кусок, а не весь документ источника, и права на документ
    целиком у неё может не быть.
    """

    __tablename__ = "page_transclusions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    #: Идентификатор узла в документе, строкой: его ставит редактор.
    transclusion_id: Mapped[str] = mapped_column(String)
    content: Mapped[dict[str, Any]] = mapped_column(JSONB)


class PageTransclusionReference(Base, CreatedMixin):
    """Кто на какой блок ссылается.

    Обратная связь: по ней страница-источник знает, где её кусок показан, и по
    ней же ссылка находится, когда источник правится.
    """

    __tablename__ = "page_transclusion_references"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    reference_page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    source_page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    transclusion_id: Mapped[str] = mapped_column(String)


class PageHistory(Base, CreatedMixin):
    """Версия страницы.

    Снимок содержимого на момент правки. Нужен и человеку, и восстановлению
    после ошибочной правки, поэтому пишется в тех же случаях, что в v1.
    """

    __tablename__ = "page_history"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    slug_id: Mapped[str | None] = mapped_column(String)
    title: Mapped[str | None] = mapped_column(String)
    content: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    icon: Mapped[str | None] = mapped_column(String)
    version: Mapped[int | None] = mapped_column(Integer)
    last_updated_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class Share(Base, SoftDeleteMixin):
    """Ссылка общего доступа.

    Ключ и есть учётные данные того, кто открывает страницу без входа, поэтому
    берётся у криптографического источника.
    """

    __tablename__ = "shares"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    key: Mapped[str] = mapped_column(String)
    page_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    include_sub_pages: Mapped[bool] = mapped_column(Boolean)
    search_indexing: Mapped[bool] = mapped_column(Boolean)
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class PageVerification(Base, TimestampMixin):
    """Проверка страницы: настройка, состояние и срок.

    Одна запись на страницу. Состояние и настройка живут вместе намеренно:
    подтверждение пересчитывает срок от настройки записи, а не от того, что
    прислал клиент.
    """

    __tablename__ = "page_verifications"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    type: Mapped[str] = mapped_column(String)
    status: Mapped[str | None] = mapped_column(String)
    mode: Mapped[str | None] = mapped_column(String)
    period_amount: Mapped[int | None] = mapped_column(Integer)
    period_unit: Mapped[str | None] = mapped_column(String)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    verified_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    requested_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejected_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    rejection_comment: Mapped[str | None] = mapped_column(Text)
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class PageVerifier(Base, CreatedMixin):
    """Кто может подтверждать страницу.

    Право подтверждать берётся отсюда, а не из прав на страницу: иначе
    настройка проверки позволяла бы подтвердить самому себе.
    """

    __tablename__ = "page_verifiers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    page_verification_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    is_primary: Mapped[bool] = mapped_column(Boolean)
    added_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class ScimToken(Base, SoftDeleteMixin):
    """Токен синхронизации каталога.

    Хранится отпечатком, как и ключ API: наружу значение отдаётся один раз.
    Последние четыре символа лежат отдельно — по ним администратор опознаёт
    свой токен в списке, не видя самого токена.
    """

    __tablename__ = "scim_tokens"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(String)
    token_hash: Mapped[str] = mapped_column(String)
    token_last_four: Mapped[str] = mapped_column(String)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_enabled: Mapped[bool] = mapped_column(Boolean)
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


class UserMfa(Base, TimestampMixin):
    """Второй фактор входа.

    Секрет лежит зашифрованным, резервные коды — отпечатками. Разница
    осознанная: секрет нужен приложению в открытом виде при каждой проверке,
    а резервный код только сверяется.
    """

    __tablename__ = "user_mfa"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    method: Mapped[str] = mapped_column(String)
    secret: Mapped[str | None] = mapped_column(Text)
    is_enabled: Mapped[bool | None] = mapped_column(Boolean)
    backup_codes: Mapped[list[str] | None] = mapped_column(ARRAY(Text))


class ApiKey(Base, SoftDeleteMixin):
    """Ключ API.

    Сам ключ здесь не хранится: он подписанный токен, а запись это описание,
    по которому его отзывают. Поэтому колонки под значение ключа нет и быть не
    должно — хранить его негде и незачем.
    """

    __tablename__ = "api_keys"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    name: Mapped[str | None] = mapped_column(Text)
    creator_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Watcher(Base, CreatedMixin):
    """Подписка на изменения страницы или пространства.

    `muted_at` это отключённая подписка, а не удалённая: удалить её значило бы
    подписать человека заново при первом же действии, а он от неё отказался.
    """

    __tablename__ = "watchers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    page_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    type: Mapped[str] = mapped_column(Text)
    added_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    muted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Notification(Base, CreatedMixin):
    """Уведомление в интерфейсе.

    Отметки прочтения и отправки письма разные: письмо уходит один раз, а
    прочтение случается позже и может не случиться вовсе.
    """

    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    type: Mapped[str] = mapped_column(Text)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    page_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    space_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    comment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    data: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    emailed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Template(Base, SoftDeleteMixin):
    """Шаблон страницы.

    Область видимости ровно одна и кодируется `space_id`: пусто — шаблон
    рабочего пространства, иначе шаблон одного пространства. Промежуточных
    состояний нет.

    `ydoc` и `tsv` не описаны намеренно. Первое пишет только сервис
    совместного редактирования и не читает никто (проверено по v1), второе
    поддерживает триггер базы.
    """

    __tablename__ = "templates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    title: Mapped[str | None] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(Text)
    content: Mapped[dict[str, Any] | None] = mapped_column(NullableJsonb)
    icon: Mapped[str | None] = mapped_column(String)
    space_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    creator_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    last_updated_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    text_content: Mapped[str | None] = mapped_column(Text)


class Backlink(Base, TimestampMixin):
    """Обратная ссылка: какая страница ссылается на какую."""

    __tablename__ = "backlinks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    source_page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    target_page_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))


__all__ = [
    "AuditLog",
    "Backlink",
    "Attachment",
    "AuthAccount",
    "AuthProvider",
    "Base",
    "CreatedMixin",
    "SoftDeleteMixin",
    "Comment",
    "Favorite",
    "Group",
    "GroupUser",
    "Label",
    "Page",
    "PageAccess",
    "PageLabel",
    "PageHistory",
    "PagePermission",
    "Share",
    "Space",
    "SpaceMember",
    "User",
    "UserToken",
    "UserSession",
    "Workspace",
    "WorkspaceInvitation",
]
