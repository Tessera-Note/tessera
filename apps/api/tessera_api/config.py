"""Настройки приложения.

Читаются из окружения один раз при сборке приложения. Значения по умолчанию
задаются здесь и только здесь: в v1 умолчание жило в коде, а `compose`
подставлял пустую строку, и она умолчание перебивала. Пустое значение здесь
приравнено к отсутствующему, чтобы это не повторилось.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str = "") -> str:
    """Значение переменной, где пустая строка равносильна отсутствию.

    Причина: `compose` перечисляет окружение поимённо и подставляет пустую
    строку тем переменным, которых нет в файле окружения. Без этого правила
    такая переменная перебивала бы умолчание, заданное в коде.
    """
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value


def _require(name: str) -> str:
    value = _env(name)
    if not value:
        raise RuntimeError(f"Переменная окружения {name} обязательна и не задана")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    """Настройки, с которыми поднимается приложение."""

    database_url: str
    redis_url: str
    app_secret: str
    app_url: str
    port: int
    host: str
    debug: bool
    trust_proxy_hops: int
    mail_driver: str = "log"
    mail_from_address: str = "noreply@tessera.local"
    mail_from_name: str = "Tessera"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_secure: bool = False
    storage_driver: str = "local"
    storage_local_path: str = "/app/data/storage"
    s3_endpoint: str | None = None
    s3_bucket: str | None = None
    s3_region: str = "us-east-1"
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_force_path_style: bool = True
    # Ключи Google для входа. Общие на установку, а не на пространство:
    # обратный адрес регистрируется у Google один и не может нести ни
    # поддомена, ни идентификатора провайдера. Решение пускать через Google
    # принимает пространство — строкой провайдера, — а ключи приходят отсюда.
    google_client_id: str | None = None
    google_client_secret: str | None = None
    file_upload_size_limit: int = 50 * 1024 * 1024
    # Ввозимый архив крупнее обычного вложения: в нём не один файл, а целое
    # пространство. Предел тот же, что в v1.
    file_import_size_limit: int = 200 * 1024 * 1024
    # Настройки ИИ из окружения. Применяются только к пространству, которое не
    # выбрало провайдера само: как только выбрало, наследуется отсюда ничего,
    # включая имена моделей — они у провайдеров несовместимы.
    ai_driver: str | None = None
    ai_base_url: str | None = None
    openai_api_key: str | None = None
    gemini_api_key: str | None = None
    ollama_api_url: str | None = None
    ai_chat_model: str | None = None
    ai_completion_model: str | None = None
    ai_embedding_model: str | None = None
    # Приёмник счётчиков установки. Пустое значение выключает отправку: в
    # развёртывании без `tessera-hub` она каждые сутки писала бы в журнал
    # отказ соединения.
    hub_internal_url: str = ""
    #: Публичный адрес соседа. Отличается от внутреннего: по внутреннему ходит
    #: сервер внутри сети развёртывания, а этот открывается в браузере человека.
    hub_url: str = "http://localhost:4000"
    disable_telemetry: bool = False
    # Общий секрет для внутренних маршрутов совместного редактирования. Ими
    # пользуется только сосед на Node; пустое значение выключает их вовсе.
    collab_internal_token: str = ""
    # Адрес соседнего сервиса преобразования содержимого. Схема узлов
    # редактора живёт там, и второй её реализации быть не должно.
    content_service_url: str = "http://tessera-v2-collab:3001"
    #: Печать в PDF. Пустой адрес Gotenberg выключает выгрузку: развёртывание
    #: без него должно подниматься, а не падать.
    gotenberg_url: str = ""
    #: Откуда Gotenberg берёт страницу отрисовки. Пустое значение означает
    #: `app_url`: обычно это один адрес, а различаются они там, где браузер
    #: печати ходит внутренним именем сети.
    pdf_render_base_url: str = ""
    pdf_export_timeout: float = 120.0

    @classmethod
    def from_env(cls) -> Settings:
        secret = _require("APP_SECRET")
        if len(secret) < 32:
            # Та же проверка, что в v1: короткий ключ подписывает токены,
            # которые подделываются перебором, и молча этого не заметить.
            raise RuntimeError("APP_SECRET должен быть не короче 32 символов")

        return cls(
            database_url=_require("DATABASE_URL"),
            redis_url=_require("REDIS_URL"),
            app_secret=secret,
            app_url=_env("APP_URL", "http://localhost:3000"),
            port=int(_env("PORT", "3000")),
            host=_env("HOST", "0.0.0.0"),
            debug=_env("DEBUG_MODE", "false").lower() == "true",
            # Число доверенных прокси, а не «доверять всей цепочке». По этому
            # адресу считаются пороги частоты и пишется журнал аудита, и
            # доверие цепочке позволяло подставить адрес заголовком.
            trust_proxy_hops=max(0, int(_env("TRUST_PROXY_HOPS", "1"))),
            # Умолчание `log`, как в v1: развёртывание без почты обязано
            # подниматься, а не падать на отсутствии SMTP.
            mail_driver=_env("MAIL_DRIVER", "log"),
            mail_from_address=_env("MAIL_FROM_ADDRESS", "noreply@tessera.local"),
            mail_from_name=_env("MAIL_FROM_NAME", "Tessera"),
            smtp_host=_env("SMTP_HOST") or None,
            smtp_port=int(_env("SMTP_PORT", "587")),
            google_client_id=_env("GOOGLE_CLIENT_ID") or None,
            google_client_secret=_env("GOOGLE_CLIENT_SECRET") or None,
            smtp_username=_env("SMTP_USERNAME") or None,
            smtp_password=_env("SMTP_PASSWORD") or None,
            smtp_secure=_env("SMTP_SECURE", "false").lower() == "true",
            # Имена переменных хранилища взяты из v1 без изменений: одно и то
            # же развёртывание должно поднимать обе версии на время перехода.
            storage_driver=_env("STORAGE_DRIVER", "local").lower(),
            storage_local_path=_env("STORAGE_LOCAL_PATH", "/app/data/storage"),
            ai_driver=(_env("AI_DRIVER") or "").strip().lower() or None,
            ai_base_url=_env("AI_BASE_URL") or None,
            openai_api_key=_env("OPENAI_API_KEY") or None,
            gemini_api_key=_env("GEMINI_API_KEY") or None,
            # Умолчание намеренное: локальная модель почти всегда стоит здесь,
            # и требовать переменную ради адреса по умолчанию незачем.
            ollama_api_url=_env("OLLAMA_API_URL", "http://localhost:11434") or None,
            ai_chat_model=_env("AI_CHAT_MODEL") or None,
            ai_completion_model=_env("AI_COMPLETION_MODEL") or None,
            ai_embedding_model=_env("AI_EMBEDDING_MODEL") or None,
            hub_internal_url=_env("HUB_INTERNAL_URL", ""),
            hub_url=_env("HUB_URL", "http://localhost:4000"),
            disable_telemetry=_env("DISABLE_TELEMETRY", "false").lower() == "true",
            collab_internal_token=_env("COLLAB_INTERNAL_TOKEN", ""),
            gotenberg_url=_env("GOTENBERG_URL", ""),
            pdf_render_base_url=_env("PDF_RENDER_BASE_URL", ""),
            pdf_export_timeout=float(_env("PDF_EXPORT_TIMEOUT", "120")),
            content_service_url=_env(
                "CONTENT_SERVICE_URL", "http://tessera-v2-collab:3001"
            ),
            s3_endpoint=_env("AWS_S3_ENDPOINT") or None,
            s3_bucket=_env("AWS_S3_BUCKET") or None,
            s3_region=_env("AWS_S3_REGION", "us-east-1"),
            s3_access_key_id=_env("AWS_S3_ACCESS_KEY_ID") or None,
            s3_secret_access_key=_env("AWS_S3_SECRET_ACCESS_KEY") or None,
            # MinIO не умеет виртуальные хосты бакетов, и в v1 здесь тоже
            # `true`. Значение по умолчанию именно такое, а не «как у AWS».
            s3_force_path_style=_env("AWS_S3_FORCE_PATH_STYLE", "true").lower() == "true",
            file_upload_size_limit=_parse_size(
                _env("FILE_UPLOAD_SIZE_LIMIT", "50mb"), "FILE_UPLOAD_SIZE_LIMIT"
            ),
            file_import_size_limit=_parse_size(
                _env("FILE_IMPORT_SIZE_LIMIT", "200mb"), "FILE_IMPORT_SIZE_LIMIT"
            ),
        )


#: Множители размеров. Значение в окружении записано как `50mb`, потому что так
#: оно записано в v1 и в документации развёртывания.
_SIZE_UNITS = {"b": 1, "kb": 1024, "mb": 1024**2, "gb": 1024**3}


def _parse_size(value: str, name: str = "FILE_UPLOAD_SIZE_LIMIT") -> int:
    """Разобрать размер вида `50mb`.

    Голое число трактуется как байты. Неразбираемое значение — отказ на старте,
    а не молчаливое умолчание: предел размера загрузки, ставший неожиданно
    другим, обнаруживается уже отказами загрузки у людей.
    """
    text = value.strip().lower()
    if text.isdigit():
        return int(text)
    for suffix, multiplier in sorted(_SIZE_UNITS.items(), key=lambda x: -len(x[0])):
        if text.endswith(suffix):
            number = text[: -len(suffix)].strip()
            if not number.replace(".", "", 1).isdigit():
                break
            return int(float(number) * multiplier)
    raise RuntimeError(f"{name} не разбирается: {value!r}")
