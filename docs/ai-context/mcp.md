# MCP

## Маршрут

`api/mcp.py`, один обработчик по пути `/mcp` — вне общего префикса `/api`, так требует протокол. Реализация инструментов в `services/mcp.py`.

Протокол JSON-RPC поверх HTTP: согласование версии, перечисление инструментов, вызов инструмента. Отказ инструмента возвращается результатом, а не ошибкой протокола — иначе клиент считает сломанным весь сеанс.

## Аутентификация

Ключом API. Права у вызова ровно те же, что у человека, которому принадлежит ключ: проверка доступа к странице идёт тем же путём, что в HTTP.

Отдельное ограничение частоты: глобального предела на `/mcp` нет.

## Инструменты

63 штуки. Группы.

| Группа | Примеры |
| --- | --- |
| пространства и страницы | `list_spaces`, `list_pages`, `get_page`, `create_page`, `update_page`, `move_page`, `duplicate_page`, `restore_page`, `list_trash` |
| поиск | `search_workspace`, `search_semantic`, `search_attachments`, `search_everything`, `search_web` |
| обсуждение и метки | `list_page_comments`, `create_comment`, `update_comment`, `list_labels`, `add_page_labels`, `find_pages_by_label` |
| вложения и вывоз | `upload_attachment`, `get_attachment_info`, `export_page` |
| шаблоны | `get_template`, `create_template`, `update_template`, `delete_template`, `use_template` |
| bases | `list_bases`, `create_base`, `convert_page_to_base`, `export_base_csv`, свойства, строки и представления |
| прочее | `list_favorites`, `add_favorite`, `list_page_history`, `get_page_version`, `reindex_embeddings` |

## Правило при добавлении инструмента

Инструмент это ещё одна точка того же контракта. Новый инструмент, выдающий содержимое страницы, обязан пройти `services/page_access.py`, а не только проверку членства в space.

Обратное тоже верно: правило, добавленное в HTTP, надо проверить и здесь.
