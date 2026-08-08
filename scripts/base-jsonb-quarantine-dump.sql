-- Выгрузка карантина jsonb-значений модуля base.
--
-- В таблицу `base_jsonb_quarantine` миграции 20260805T170000 и 20260805T180000
-- переносят значения, которые не разбираются как объект, до того как обнулить
-- колонку. Таблица не удаляется автоматически: разбирать содержимое и решать
-- судьбу этих строк должен человек.
--
--   psql -f scripts/base-jsonb-quarantine-dump.sql
--
-- Для выгрузки в файл:
--   psql -A -F',' -f scripts/base-jsonb-quarantine-dump.sql -o карантин.csv

\echo '=== сводка по колонкам ==='

SELECT table_name AS таблица,
       column_name AS колонка,
       count(*) AS строк,
       min(quarantined_at) AS первая,
       max(quarantined_at) AS последняя
FROM base_jsonb_quarantine
GROUP BY table_name, column_name
ORDER BY 1, 2;

\echo ''
\echo '=== содержимое ==='

SELECT table_name AS таблица,
       column_name AS колонка,
       row_id AS строка,
       quarantined_at AS перенесено,
       original_value AS исходное_значение
FROM base_jsonb_quarantine
ORDER BY table_name, column_name, quarantined_at;

\echo ''
\echo '=== связь с живыми строками ==='
\echo 'Существует ли еще строка, из которой значение перенесено.'

SELECT q.table_name AS таблица,
       q.row_id AS строка,
       CASE q.table_name
         WHEN 'base_rows' THEN EXISTS (SELECT 1 FROM base_rows r WHERE r.id::text = q.row_id)
         WHEN 'base_properties' THEN EXISTS (SELECT 1 FROM base_properties p WHERE p.id::text = q.row_id)
         WHEN 'base_views' THEN EXISTS (SELECT 1 FROM base_views v WHERE v.id::text = q.row_id)
         WHEN 'pages' THEN EXISTS (SELECT 1 FROM pages g WHERE g.id::text = q.row_id)
       END AS строка_существует
FROM base_jsonb_quarantine q
ORDER BY 1, 2;
