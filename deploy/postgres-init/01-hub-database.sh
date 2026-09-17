#!/usr/bin/env bash
# Creates the database and the role for tessera-hub during the first
# initialization of the cluster.
#
# The postgres image runs this script only when the data directory is empty. On
# an existing installation the same commands have to be run by hand, see
# docs/deployment-from-scratch.md.
set -euo pipefail

HUB_DB="${HUB_POSTGRES_DB:-tessera_hub}"
HUB_USER="${HUB_POSTGRES_USER:-tessera_hub}"
HUB_PASSWORD="${HUB_POSTGRES_PASSWORD:?HUB_POSTGRES_PASSWORD is required}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<-EOSQL
    CREATE ROLE "$HUB_USER" WITH LOGIN PASSWORD '$HUB_PASSWORD';
    CREATE DATABASE "$HUB_DB" OWNER "$HUB_USER";
EOSQL
