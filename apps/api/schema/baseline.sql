-- Объекты базы, которыми Atlas не управляет: расширения, функции и настройка
-- поиска. Применяется **до** Atlas.
--
-- Замерено: Atlas в свободной редакции пропускает триггеры, функции и прочие
-- объекты сверх таблиц («Skipping triggers, functions, stored procedures and
-- other advanced objects»). Для этой схемы это не мелочь: на пропущенных
-- объектах держится весь полнотекстовый поиск и генерация идентификаторов.
--
-- Проверено обратным диффом: без gen_uuid_v7 в рабочей базе Atlas не может
-- построить схему и падает на первой же таблице.
--
-- Триггеры сюда не входят и лежат в `after-atlas.sql`: они ссылаются на таблицы,
-- а таблицы создаёт Atlas. Пока они были в этом файле, применение на чистую
-- базу падало на первом же из них — и это выяснилось только тогда, когда
-- чистая база появилась.
--
-- Файл ведётся руками и снимается с рабочей базы.
--
-- Расширения намеренно первыми: от них зависят типы колонок (vector) и
-- функции (unaccent).

CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE OR REPLACE FUNCTION public.ai_chat_messages_tsvector_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    BEGIN
      NEW.tsv := to_tsvector('tessera_search', f_unaccent(substring(coalesce(NEW.content, ''), 1, 100000)));
      RETURN NEW;
    END;
    $function$
;
CREATE OR REPLACE FUNCTION public.attachments_tsvector_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    begin
        new.tsv := to_tsvector(
          'tessera_search',
          f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))
        );
        return new;
    end;
    $function$
;
CREATE OR REPLACE FUNCTION public.base_cell_array(cells jsonb, prop text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$ SELECT cells->prop::text $function$
;
CREATE OR REPLACE FUNCTION public.base_cell_bool(cells jsonb, prop text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
      SELECT CASE jsonb_typeof(cells->prop::text)
        WHEN 'boolean' THEN (cells->>prop::text)::boolean
        WHEN 'string' THEN
          CASE
            WHEN lower(btrim(cells->>prop::text)) IN
              ('true','t','yes','y','on','1','false','f','no','n','off','0')
            THEN (cells->>prop::text)::boolean
          END
      END
    $function$
;
CREATE OR REPLACE FUNCTION public.base_cell_numeric(cells jsonb, prop text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
      SELECT CASE jsonb_typeof(cells->prop::text)
        WHEN 'number' THEN (cells->>prop::text)::numeric
        WHEN 'string' THEN
          CASE
            WHEN (cells->>prop::text) ~
              '^[[:space:]]*[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?[[:space:]]*$'
            THEN (cells->>prop::text)::numeric
          END
      END
    $function$
;
CREATE OR REPLACE FUNCTION public.base_cell_text(cells jsonb, prop text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$ SELECT cells->>prop::text $function$
;
CREATE OR REPLACE FUNCTION public.base_cell_timestamptz(cells jsonb, prop text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
      BEGIN RETURN (cells->>prop::text)::timestamptz;
      EXCEPTION WHEN others THEN RETURN NULL; END;
    $function$
;
CREATE OR REPLACE FUNCTION public.f_unaccent(text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
      SELECT unaccent('unaccent', $1);
    $function$
;
CREATE OR REPLACE FUNCTION public.gen_uuid_v7()
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
        declare
              v_time numeric := null;
      
              v_unix_t numeric := null;
              v_rand_a numeric := null;
              v_rand_b numeric := null;
      
              v_unix_t_hex varchar := null;
              v_rand_a_hex varchar := null;
              v_rand_b_hex varchar := null;
      
              v_output_bytes bytea := null;
              
              c_milli_factor numeric := 10^3::numeric;  -- 1000
              c_micro_factor numeric := 10^6::numeric;  -- 1000000
              c_scale_factor numeric := 4.096::numeric; -- 4.0 * (1024 / 1000)
              
              c_version bit(64) := x'0000000000007000'; -- RFC-4122 version: b'0111...'
              c_variant bit(64) := x'8000000000000000'; -- RFC-4122 variant: b'10xx...'
        begin
              v_time := extract(epoch from clock_timestamp());
              
              v_unix_t := trunc(v_time * c_milli_factor);
              v_rand_a := ((v_time * c_micro_factor) - (v_unix_t * c_milli_factor)) * c_scale_factor;
              v_rand_b := random()::numeric * 2^62::numeric;
              
              v_unix_t_hex := lpad(to_hex(v_unix_t::bigint), 12, '0');
              v_rand_a_hex := lpad(to_hex((v_rand_a::bigint::bit(64) | c_version)::bigint), 4, '0');
              v_rand_b_hex := lpad(to_hex((v_rand_b::bigint::bit(64) | c_variant)::bigint), 16, '0');
              
              v_output_bytes := decode(v_unix_t_hex || v_rand_a_hex || v_rand_b_hex, 'hex');
    
              return encode(v_output_bytes, 'hex')::uuid;
              
              v_output_bytes := decode(v_unix_t_hex || v_rand_a_hex || v_rand_b_hex, 'hex');
    
              return encode(v_output_bytes, 'hex')::uuid;
     end $function$
;
CREATE OR REPLACE FUNCTION public.jsonb_set_many(target jsonb, patches jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
AS $function$
      DECLARE k text; v jsonb; result jsonb := coalesce(target, '{}'::jsonb);
      BEGIN
        IF patches IS NULL OR jsonb_typeof(patches) <> 'object' THEN
          RETURN result;
        END IF;
        FOR k, v IN SELECT * FROM jsonb_each(patches) LOOP
          IF v = 'null'::jsonb THEN
            result := result - k;
          ELSE
            result := jsonb_set(result, ARRAY[k], v, true);
          END IF;
        END LOOP;
        RETURN result;
      END;
    $function$
;
CREATE OR REPLACE FUNCTION public.pages_tsvector_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    begin
        new.tsv :=
                  setweight(to_tsvector('tessera_search', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('tessera_search', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $function$
;
CREATE OR REPLACE FUNCTION public.templates_tsvector_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    begin
        new.tsv :=
                  setweight(to_tsvector('tessera_search', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('tessera_search', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $function$
;
CREATE TEXT SEARCH CONFIGURATION tessera_search ( COPY = russian );
