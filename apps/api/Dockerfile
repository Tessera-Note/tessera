# Бэкенд Tessera v2.
#
# Образ собирается из исходников этого каталога. Зависимости ставятся uv из
# файла блокировки: сборка обязана быть воспроизводимой, иначе два развёртывания
# из одного коммита дадут разные образы.
FROM python:3.13-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY --from=ghcr.io/astral-sh/uv:0.10.2 /uv /usr/local/bin/uv

WORKDIR /app

# Зависимости отдельным слоем: правка исходников не должна перекачивать пакеты.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY tessera_api ./tessera_api
RUN uv sync --frozen --no-dev

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 3000

# Сервер запускается напрямую, а не через `litestar run`. Команда CLI читает из
# окружения LITESTAR_DEBUG, LITESTAR_PDB и LITESTAR_RELOAD (объявлены как envvar
# в её исходнике), то есть переменная, попавшая в контейнер, меняет режим работы
# приложения снаружи. У точки входа в прод такой поверхности быть не должно.
#
# Порт и адрес берутся из окружения теми же именами, что в v1.
CMD ["sh", "-c", "uvicorn --factory tessera_api.app:create_app --host ${HOST:-0.0.0.0} --port ${PORT:-3000}"]
