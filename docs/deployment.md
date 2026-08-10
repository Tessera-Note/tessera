# Deploy de produção

O deploy de produção é feito pelo GitHub Actions a cada push na branch `main` e pode ser executado manualmente em **Actions → Deploy production → Run workflow**.

## GitHub Environment

Crie o environment `production` no repositório e configure:

Secrets:

- `VPS_HOST=167.86.117.142`
- `VPS_USER=root`
- `VPS_SSH_KEY`: chave privada SSH autorizada para o usuário `root`
- `APP_SECRET`: segredo aleatório com pelo menos 32 caracteres
- `POSTGRES_PASSWORD`: senha do banco
- `HUB_POSTGRES_PASSWORD`: senha da role `tessera_hub`
- `MINIO_ROOT_PASSWORD`: senha do armazenamento de anexos
- `CERTBOT_EMAIL`: e-mail para avisos do Let’s Encrypt
- `GHCR_PULL_TOKEN`: token clássico com `read:packages`, caso o pacote GHCR seja privado

Variables:

- `DEPLOY_PATH=/opt/tessera`
- `APP_DOMAIN=wiki.cledson.com.br`
- `APP_PORT=3000`
- `APP_URL=https://wiki.cledson.com.br`
- `HUB_PORT=4000`
- `DRAWIO_PORT=8081`


До первого развертывания завести запись DNS типа A для `wiki.cledson.com.br`, указывающую на `167.86.117.142`, и открыть в межсетевом экране VPS порты TCP 80, 443 и 22. Nginx публикует приложение на петлевом интерфейсе, Certbot настраивает HTTPS после того, как DNS разойдется.

## Rede de segurança do deploy

- Antes de subir a nova imagem (cujo boot aplica migrations pendentes), o script gera um dump `pre-deploy-<stamp>.sql.gz` em `<DEPLOY_PATH>/backups`. Se o dump falhar, o deploy é abortado antes de qualquer migration. Os 5 dumps pré-deploy mais recentes são mantidos.
- Se o healthcheck da nova imagem falhar, o script tenta voltar automaticamente à imagem que estava rodando antes e ainda encerra com erro, para o workflow acusar a falha.
- Para rollback manual, execute novamente o workflow usando um commit anterior ou publique novamente a tag SHA anterior no mesmo environment. Rollback reverte o código, não o schema; para reverter dados, restaure o dump pré-deploy correspondente.

## Внутренние сервисы

Развертывание не обращается наружу, кроме провайдера модели для ИИ и SMTP. Кроме приложения, базы и Redis поднимаются следующие сервисы.

| Сервис | Назначение | Публикация |
|---|---|---|
| `tessera-hub` | версии, прием телеметрии, документация, лицензия, поддержка | петлевой интерфейс на `HUB_PORT`, nginx отдает на `/hub/` |
| `tessera-drawio` | редактор диаграмм | петлевой интерфейс на `DRAWIO_PORT`, nginx отдает на `/drawio/` |
| `tessera-minio` | хранилище вложений по протоколу S3 | только внутренняя сеть |
| `tessera-minio-init` | разовое создание бакета | завершается после успеха |

Дополнительные переменные окружения.

- `HUB_IMAGE` — образ внутреннего сервиса, собирается из `services/hub` тем же конвейером, что и основной, и передается скрипту деплоя рядом с `WEB_IMAGE`
- `HUB_POSTGRES_PASSWORD` — пароль роли `tessera_hub`, по умолчанию берется `POSTGRES_PASSWORD`
- `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_BUCKET` — доступ к хранилищу вложений
- `HUB_URL`, `DRAWIO_URL` — адреса для браузера, по умолчанию `${APP_URL}/hub` и `${APP_URL}/drawio`
- `HUB_SUPPORT_EMAIL` — адрес, который показывает страница поддержки
- `HUB_SEED_RELEASE_VERSION` — версия, регистрируемая при старте сервиса, если такой еще нет

## Переход с имен docmost на tessera

Переименование затронуло имена сервисов, базы, роли и томов. На существующей установке они не переименуются сами: том с новым именем создастся пустым, а приложение поднимется на пустой базе. Порядок перехода следующий, шаги выполняются на сервере.

1. Снять полный дамп и остановить стек

```bash
cd "$DEPLOY_PATH"
docker compose -f deploy/docker-compose.vps.yml exec -T db \
  pg_dump --format=custom --no-owner --no-privileges -U docmost -d docmost > /root/tessera-migration.dump
docker compose -f deploy/docker-compose.vps.yml down
```

2. Скопировать данные томов под новые имена

Фактические имена посмотреть командой `docker volume ls`, префикс равен имени проекта compose.

```bash
for pair in "docmost_docmost:docmost_tessera" \
            "docmost_db_data:docmost_tessera_db_data" \
            "docmost_redis_data:docmost_tessera_redis_data"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  docker volume create "$dst"
  docker run --rm -v "$src":/from -v "$dst":/to alpine sh -c 'cd /from && cp -a . /to'
done
```

3. Поднять базу и переименовать роль и базу данных

```bash
docker compose -f deploy/docker-compose.vps.yml up -d tessera-db
docker compose -f deploy/docker-compose.vps.yml exec -T tessera-db psql -U docmost -d postgres \
  -c 'ALTER DATABASE docmost RENAME TO tessera;' \
  -c 'ALTER ROLE docmost RENAME TO tessera;'
```

4. Создать базу и роль внутреннего сервиса

Скрипт `deploy/postgres-init/01-hub-database.sh` отрабатывает только на пустом кластере, поэтому на существующей установке те же шаги выполняются руками.

```bash
docker compose -f deploy/docker-compose.vps.yml exec -T tessera-db psql -U tessera -d postgres \
  -c "CREATE ROLE tessera_hub WITH LOGIN PASSWORD '<HUB_POSTGRES_PASSWORD>';" \
  -c 'CREATE DATABASE tessera_hub OWNER tessera_hub;'
```

5. Перенести вложения в хранилище

Драйвер хранилища переключен на `s3` и указывает на `tessera-minio`, поэтому файлы переносятся в бакет один раз.

```bash
docker compose -f deploy/docker-compose.vps.yml up -d tessera-minio tessera-minio-init
docker run --rm --network "$(basename "$DEPLOY_PATH")_default" \
  -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD \
  -v docmost_tessera:/data minio/mc:RELEASE.2025-04-16T18-13-26Z sh -c '
    mc alias set t http://tessera-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
    mc mirror --overwrite /data t/tessera'
```

Если переносить вложения не требуется, оставить в окружении приложения `STORAGE_DRIVER=local`: тогда файлы продолжат читаться из тома.

6. Обновить `.env` на сервере новыми переменными и запустить деплой обычным способом. Первый старт приложения применит свои миграции, старт `tessera-hub` — свои.

7. Проверить, что страницы, вложения и история на месте. Старые тома удалять только после этого, отдельной ручной командой.

## Приложение должно быть доступно только через обратный прокси

Адрес клиента берется из `X-Forwarded-For` с одним доверенным переходом
(`TRUST_PROXY_HOPS`, по умолчанию 1). Это верно ровно до тех пор, пока к
приложению нельзя подключиться в обход nginx: доверенным считается ближайший
узел, и если им оказывается сам клиент, присланный им заголовок снова
принимается за адрес.

По этому адресу считаются пороги частоты запросов и пишется адрес в журнал
аудита. Выставленный наружу порт приложения означает и обход лимитов
подстановкой заголовка, и недостоверный адрес в журнале, то есть журнал
перестает годиться для разбора происшествия.

Поэтому порт приложения публикуется на петлевом интерфейсе, наружу открыты
только 80 и 443 у nginx. Проверить: `ss -ltnp` не должен показывать порт
приложения на `0.0.0.0`, а `curl` с чужой машины на этот порт не должен
отвечать.
