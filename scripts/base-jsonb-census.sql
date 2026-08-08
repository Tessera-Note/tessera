-- Перепись jsonb-значений модуля base перед нормализацией.
--
-- Запускать на реальном развертывании ДО применения миграций
-- 20260805T170000-normalize-base-jsonb и 20260805T180000-normalize-base-page-content.
--
-- Первый запрос дает распределение форм по четырем колонкам.
-- (pending_type_options снята миграцией 20260805T200000 и здесь не проверяется.)
-- Второй перечисляет строки, которые миграция не сможет разобрать. Они не
-- теряются: миграция переносит их в base_jsonb_quarantine до нормализации и
-- пишет число перенесенных строк в вывод старта. Перепись показывает объем
-- заранее, обязательным шагом перед обновлением она не является.

\echo '=== распределение форм ==='

SELECT 'base_rows.cells' AS колонка,
       COALESCE(jsonb_typeof(cells), 'SQL NULL') AS форма,
       count(*) AS строк
FROM base_rows GROUP BY 2
UNION ALL
SELECT 'base_properties.type_options',
       COALESCE(jsonb_typeof(type_options), 'SQL NULL'), count(*)
FROM base_properties GROUP BY 2
UNION ALL
SELECT 'base_views.config',
       COALESCE(jsonb_typeof(config), 'SQL NULL'), count(*)
FROM base_views GROUP BY 2
UNION ALL
SELECT 'pages.content (только базы)',
       COALESCE(jsonb_typeof(content), 'SQL NULL'), count(*)
FROM pages WHERE is_base = true GROUP BY 2
ORDER BY 1, 2;

\echo ''
\echo '=== строки, которые миграция обнулит (должно быть пусто) ==='

WITH подозрительные AS (
  SELECT 'base_rows.cells' AS колонка, id::text AS идентификатор,
         left(cells #>> '{}', 200) AS значение
  FROM base_rows
  WHERE cells IS NOT NULL
    AND jsonb_typeof(cells) <> 'object'
    AND NOT (
      pg_input_is_valid(cells #>> '{}', 'jsonb')
      AND jsonb_typeof((cells #>> '{}')::jsonb) = 'object'
    )

  UNION ALL
  SELECT 'base_properties.type_options', id::text,
         left(type_options #>> '{}', 200)
  FROM base_properties
  WHERE type_options IS NOT NULL
    AND jsonb_typeof(type_options) <> 'object'
    AND NOT (
      pg_input_is_valid(type_options #>> '{}', 'jsonb')
      AND jsonb_typeof((type_options #>> '{}')::jsonb) = 'object'
    )

  UNION ALL
  SELECT 'base_views.config', id::text,
         left(config #>> '{}', 200)
  FROM base_views
  WHERE config IS NOT NULL
    AND jsonb_typeof(config) <> 'object'
    AND NOT (
      pg_input_is_valid(config #>> '{}', 'jsonb')
      AND jsonb_typeof((config #>> '{}')::jsonb) = 'object'
    )

  UNION ALL
  SELECT 'pages.content', id::text,
         left(content #>> '{}', 200)
  FROM pages
  WHERE content IS NOT NULL
    AND jsonb_typeof(content) <> 'object'
    AND NOT (
      pg_input_is_valid(content #>> '{}', 'jsonb')
      AND jsonb_typeof((content #>> '{}')::jsonb) = 'object'
    )
)
SELECT * FROM подозрительные ORDER BY колонка, идентификатор;

\echo ''
\echo '=== объемы таблиц для оценки времени прогона ==='

SELECT 'pages' AS таблица, count(*) AS строк,
       pg_size_pretty(pg_total_relation_size('pages')) AS размер FROM pages
UNION ALL SELECT 'base_rows', count(*),
       pg_size_pretty(pg_total_relation_size('base_rows')) FROM base_rows
UNION ALL SELECT 'base_properties', count(*),
       pg_size_pretty(pg_total_relation_size('base_properties')) FROM base_properties
UNION ALL SELECT 'base_views', count(*),
       pg_size_pretty(pg_total_relation_size('base_views')) FROM base_views
ORDER BY 1;
