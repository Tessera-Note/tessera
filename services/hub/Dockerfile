FROM python:3.13-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH

COPY --from=ghcr.io/astral-sh/uv:0.10.2 /uv /usr/local/bin/uv

WORKDIR /app

# Зависимости ставятся отдельным слоем, чтобы правка кода не пересобирала их.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY hub ./hub
COPY migrations ./migrations
COPY alembic.ini ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN uv sync --frozen --no-dev \
    && chmod +x /usr/local/bin/docker-entrypoint.sh \
    && useradd --system --uid 10001 --home /app hub \
    && chown -R hub:hub /app

USER hub

EXPOSE 4000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["litestar", "--app-dir", "/app", "--app", "hub.app:create_app", "run", "--host", "0.0.0.0", "--port", "4000"]
