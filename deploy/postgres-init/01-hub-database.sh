#!/usr/bin/env bash
# Создает базу и роль для tessera-hub при первичной инициализации кластера.
#
# Скрипт выполняется образом postgres только когда каталог данных пуст. На
# существующей установке те же команды надо выполнить вручную, см.
# docs/deployment.md.
set -euo pipefail

HUB_DB="${HUB_POSTGRES_DB:-tessera_hub}"
HUB_USER="${HUB_POSTGRES_USER:-tessera_hub}"
HUB_PASSWORD="${HUB_POSTGRES_PASSWORD:?HUB_POSTGRES_PASSWORD обязателен}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<-EOSQL
    CREATE ROLE "$HUB_USER" WITH LOGIN PASSWORD '$HUB_PASSWORD';
    CREATE DATABASE "$HUB_DB" OWNER "$HUB_USER";
EOSQL
