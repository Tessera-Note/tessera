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
