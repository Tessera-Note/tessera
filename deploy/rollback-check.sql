-- Заслон отката: не даёт вернуть конфигурацию прокси, пока в общей базе
-- остаются строки, удалённые второй версией мягко.
--
-- Первая версия три таблицы читает без отметки `deleted_at`, поэтому отозванная
-- публичная ссылка снова откроет страницу, а снятый участник снова получит
-- доступ. Перед возвратом конфигурации эти строки удаляют из трёх таблиц:
-- `shares`, `space_members`, `comments` — всё, где стоит `deleted_at`. Раньше
-- порядок держался на том, что человек прочитает пометку «обязательно».
-- Теперь пропустить шаг нельзя: возврат идёт только после нулевого выхода
-- этой проверки.
--
-- Запуск (выход 0 — можно возвращать конфигурацию, иначе psql вернёт отказ):
--
--   psql -h ХОСТ -U tessera -d tessera -v ON_ERROR_STOP=1 -f deploy/rollback-check.sql
--
-- Пространства сюда не входят: их первая версия удаляет своими средствами,
-- уже после возврата конфигурации.

DO $$
DECLARE
    revoked bigint;
    removed bigint;
    deleted bigint;
BEGIN
    SELECT count(*) INTO revoked FROM shares WHERE deleted_at IS NOT NULL;
    SELECT count(*) INTO removed FROM space_members WHERE deleted_at IS NOT NULL;
    SELECT count(*) INTO deleted FROM comments WHERE deleted_at IS NOT NULL;

    IF revoked > 0 OR removed > 0 OR deleted > 0 THEN
        RAISE EXCEPTION E'Откат остановлен: строки с отметкой удаления остались.\nshares: %, space_members: %, comments: %.\nУдалите строки с отметкой удаления в этих трёх таблицах и повторите проверку.',
            revoked, removed, deleted;
    END IF;

    RAISE NOTICE 'Проверка пройдена: в shares, space_members и comments строк с отметкой удаления нет. Конфигурацию прокси можно возвращать.';
END $$;
