-- Объекты, которые создаются **после** Atlas: они ссылаются на таблицы, а
-- таблицы создаёт он.
--
-- Триггеры полнотекстового поиска. В `baseline.sql` их держать нельзя:
-- применение на чистую базу падало на первом же — `relation does not exist`.
-- Функции, на которые они ссылаются, заведены там же, до Atlas: иначе не
-- построятся умолчания первичных ключей.
--
-- Четыре индекса по ключу порядка. Они здесь по другой причине: **Atlas в
-- свободной редакции не видит `COLLATE` у колонки индекса**. Замерено обоими
-- концами — `schema inspect` рабочей базы отдаёт эти индексы без сортировки, а
-- `schema apply` создаёт их без неё же. Оставь их в `schema.hcl` — и очередное
-- применение к общей базе пересоздало бы рабочие индексы v1 без сортировки,
-- молча и с блокировкой на время перестройки.
--
-- Сортировка `C` взята у v1 дословно: ключ порядка это дробный индекс, и
-- сравнение его строк побайтно — то, ради чего он так устроен.
--
-- Та же сортировка ставится и самим колонкам порядка. Без неё запрос
-- `ORDER BY position` шёл сортировкой базы (`en_US.utf8`), а она ставит `h:`
-- **раньше** `h0`: одиннадцатая по счёту строка прыгала в начало списка.
-- Проверено на стенде — двенадцать строк базы вышли порядком
-- `h: h: h0 h1 … h9`, причём две с одинаковым ключом: выдача «последней»
-- позиции для новой строки тоже читалась этой сортировкой и дважды вернула
-- `h9`. Сортировка колонки чинит и то и другое, а индексы выше становятся
-- применимы, потому что их сортировка теперь совпадает с сортировкой запроса.
--
-- Все записи переписываемы: файл применяется при каждом подъёме состава, и
-- падение на «уже существует» означало бы, что вика не поднимается со второго
-- раза.

CREATE OR REPLACE TRIGGER ai_chat_messages_tsvector_update BEFORE INSERT OR UPDATE ON public.ai_chat_messages FOR EACH ROW EXECUTE FUNCTION ai_chat_messages_tsvector_trigger();
CREATE OR REPLACE TRIGGER attachments_tsvector_update BEFORE INSERT OR UPDATE OF text_content ON public.attachments FOR EACH ROW EXECUTE FUNCTION attachments_tsvector_trigger();
CREATE OR REPLACE TRIGGER pages_tsvector_update BEFORE INSERT OR UPDATE ON public.pages FOR EACH ROW EXECUTE FUNCTION pages_tsvector_trigger();
CREATE OR REPLACE TRIGGER templates_tsvector_update BEFORE INSERT OR UPDATE ON public.templates FOR EACH ROW EXECUTE FUNCTION templates_tsvector_trigger();

CREATE INDEX IF NOT EXISTS idx_base_properties_page_alive ON public.base_properties USING btree (page_id, "position" COLLATE "C", id) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_base_rows_page_alive ON public.base_rows USING btree (page_id, "position" COLLATE "C", id) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_pages_is_base ON public.pages USING btree (space_id, "position" COLLATE "C") WHERE ((is_base = true) AND (deleted_at IS NULL));
CREATE INDEX IF NOT EXISTS idx_pages_space_parent_position ON public.pages USING btree (space_id, parent_page_id, "position" COLLATE "C") WHERE (deleted_at IS NULL);

-- Сортировка колонок порядка. Идемпотентно: перезапись колонки идёт только
-- тогда, когда сортировка ещё не та, иначе каждый подъём состава переписывал
-- бы четыре таблицы целиком.
DO $$
DECLARE
    target text;
BEGIN
    FOREACH target IN ARRAY ARRAY['pages', 'base_rows', 'base_properties', 'base_views']
    LOOP
        IF (
            SELECT co.collname
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_collation co ON co.oid = a.attcollation
            WHERE n.nspname = 'public' AND c.relname = target AND a.attname = 'position'
        ) IS DISTINCT FROM 'C' THEN
            EXECUTE format(
                'ALTER TABLE public.%I ALTER COLUMN "position" TYPE character varying COLLATE "C"',
                target
            );
        END IF;
    END LOOP;
END $$;
