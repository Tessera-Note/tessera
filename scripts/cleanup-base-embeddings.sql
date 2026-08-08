-- Вычистка эмбеддингов у страниц-баз, удалённых до перевода deleteBase на PageRepo.
--
-- До этой правки deleteBase ставил deleted_at напрямую и не отправлял
-- PAGE_SOFT_DELETED, поэтому обработчик очереди про такие страницы не узнавал
-- и их эмбеддинги остались в базе. Скрипт разовый: после правки событие уходит
-- штатно и обработчик (ee/embedding/embedding.processor.ts) чистит сам.
--
-- По умолчанию сухой прогон: показывает, что будет удалено, и ничего не меняет.
-- Удаление выполняется только с явным флагом:
--   psql -v apply=1 -f scripts/cleanup-base-embeddings.sql

\if :{?apply}
\else
  \set apply 0
\endif

\echo '=== страницы-базы в корзине, у которых остались эмбеддинги ==='

SELECT p.id AS страница,
       p.title AS заголовок,
       p.deleted_at AS удалена,
       count(e.id) AS эмбеддингов
FROM pages p
JOIN page_embeddings e ON e.page_id = p.id
WHERE p.is_base = true
  AND p.deleted_at IS NOT NULL
GROUP BY p.id, p.title, p.deleted_at
ORDER BY p.deleted_at;

\echo ''
\echo '=== итого записей к удалению ==='

SELECT count(*) AS записей
FROM page_embeddings e
JOIN pages p ON p.id = e.page_id
WHERE p.is_base = true AND p.deleted_at IS NOT NULL;

\if :apply
  \echo ''
  \echo '=== удаление ==='
  DELETE FROM page_embeddings e
  USING pages p
  WHERE p.id = e.page_id
    AND p.is_base = true
    AND p.deleted_at IS NOT NULL;
\else
  \echo ''
  \echo 'Сухой прогон. Ничего не удалено. Для удаления запустить с -v apply=1'
\endif
