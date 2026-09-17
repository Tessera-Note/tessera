-- Заслон перед подъёмом образа второй версии на общую с первой базу.
--
-- Обязательная ручная правка общей базы добавляет ключ сопоставления
-- при входе через провайдера: две колонки и индекс по ним. Он помечен «до
-- подъёма образа» не для порядка: запросы второй версии к провайдерам входа и
-- их связям читают эти колонки, и без них вход через провайдера и настройки
-- единого входа отвечают пятисотыми (`UndefinedColumn`). Пропуск шага
-- обнаруживается только первым человеком, который попробует войти.
--
-- До этого заслона шаг держался на пометке в документе, то есть на внимании
-- администратора. Теперь он проверяется машиной, как и шаги отката
-- (`deploy/rollback-check.sql`).
--
-- Запуск до подъёма образа (выход 0 — можно поднимать, иначе psql вернёт
-- отказ):
--
--   psql -h ХОСТ -U tessera -d tessera -v ON_ERROR_STOP=1 -f deploy/preflight-check.sql
--
-- Флаг `ON_ERROR_STOP=1` обязателен: без него psql сообщает об отказе, но
-- возвращает нулевой выход, и заслон в скрипте пройдёт незамеченным.
--
-- Остальные шаги того же раздела в заслон не входят: они не обязательны до
-- подъёма, и без них вторая версия работает — сортировка порядка остаётся
-- такой же, как в первой версии, а занятое короткое имя удалённого
-- пространства даёт обычный отказ «имя занято».

DO $$
DECLARE
    missing text[] := ARRAY[]::text[];
    index_state boolean;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'auth_providers'
          AND column_name = 'match_claim_name'
    ) THEN
        missing := missing || 'колонка auth_providers.match_claim_name'::text;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'auth_accounts'
          AND column_name = 'match_claim_value'
    ) THEN
        missing := missing || 'колонка auth_accounts.match_claim_value'::text;
    END IF;

    SELECT i.indisvalid INTO index_state
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'idx_auth_accounts_provider_match_claim';

    IF index_state IS NULL THEN
        missing := missing || 'индекс idx_auth_accounts_provider_match_claim'::text;
    ELSIF NOT index_state THEN
        -- Недействительный индекс `CREATE INDEX ... IF NOT EXISTS` не
        -- перестраивает, а пропускает: его надо удалить и создать заново.
        missing := missing || 'индекс idx_auth_accounts_provider_match_claim недействителен'::text;
    END IF;

    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION E'Подъём остановлен: общая база не готова.\nНе хватает: %.\nДобавьте недостающее (SQL — в шапке этого файла) и повторите проверку.',
            array_to_string(missing, '; ');
    END IF;

    RAISE NOTICE 'Проверка пройдена: ключ сопоставления при входе через провайдера в базе есть, индекс действителен. Образ можно поднимать.';
END $$;
