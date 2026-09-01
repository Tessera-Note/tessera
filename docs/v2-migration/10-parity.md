# Сверка с первой версией

Перечень собран сличением маршрутов: 238 пар «метод и путь» в v1 против 206 в
v2. Разница в 90 строк — не 90 пропаж: часть из них это иные имена того же
самого (`/shares/*` против `/share/*`, `POST /spaces` против `GET /spaces`).
Ниже разобрано по существу: что работает, что называется иначе и чего нет.

Отмечается проверяемым. Строка уходит отсюда, когда возможность написана,
покрыта проверками и осмотрена глазами.

## Называется иначе, работает

| v1 | v2 |
|---|---|
| `POST /comments` | `POST /comments/list` |
| `POST /favorites` | `GET /favorites` |
| `POST /labels` | `GET /labels` |
| `POST /pages/labels`, `/labels/add`, `/labels/remove` | `/labels/for-page`, `/labels/attach`, `/labels/detach` |
| `POST /pages/history`, `/history/info` | `/pages/history/list`, `/pages/history/get` |
| `POST /shares`, `/shares/create`, `/shares/delete`, `/shares/for-page` | `/share`, `/share/create`, `/share/revoke`, `/share/for-page` |
| `POST /spaces`, `/spaces/info` | `GET /spaces`, `GET /spaces/{slug}` |
| `POST /users/me` | `GET /auth/me` |
| `POST /users/mentions` | `POST /search/suggest` |
| `POST /workspace/info`, `/workspace/members` | `GET /workspace/info`, `GET /workspace/members` |
| `POST /workspace/invites/create` | `POST /workspace/invites` |

## Нет в v2

### Содержимое страниц

- [x] `comments/update`, `comments/delete`, `comments/resolve`, `comments/info` —
      правка, удаление и пометка обсуждения решённым. Заведение и чтение есть.
- [x] `pages/watch`, `pages/unwatch`, `pages/watch-status` — подписка на
      страницу. Служба подписок в v2 есть, маршрутов нет.
- [x] `spaces/watch`, `spaces/unwatch`, `spaces/watch-status`,
      `spaces/watched-ids` — то же для пространства.
- [x] `pages/recent` — недавние страницы.
- [x] `pages/created-by-user` — страницы, заведённые человеком.
- [ ] `pages/sidebar-pages` — ветвь дерева для боковой панели.
- [x] `pages/backlinks-count` — счётчик обратных ссылок.
- [ ] `pages/transclusion/lookup`, `/references`, `/unsync-reference` —
      включение куска чужой страницы. Узлы схемы есть, маршрутов нет.
- [ ] `labels/info` — метка и число страниц с ней.
- [ ] `favorites/ids` — только идентификаторы избранного.

### Ссылки общего доступа

- [ ] `shares/update` — правка настроек ссылки (подстраницы, индексация).
- [ ] `shares/tree` — дерево страниц внутри опубликованной ветви.
- [ ] `shares/page-info`, `shares/info` — сведения об опубликованной странице.
- [ ] `shares/transclusion/lookup` — включения внутри опубликованной страницы.
- [ ] `search/share-search` — поиск внутри опубликованной ветви.

### Учётные записи и охрана

- [x] `sessions`, `sessions/revoke`, `sessions/revoke-all` — свои сеансы и их
      отзыв.
- [ ] `sso/providers`, `sso/create`, `sso/update`, `sso/delete`, `sso/info`,
      `sso/unlink` — управление провайдерами входа. Сам вход через них работает.
- [ ] `scim-tokens`, `/create`, `/revoke`, `/update` — токены синхронизации
      каталога. Служба в v2 есть, маршрутов нет.
- [ ] `mfa/validate-access` — проверка второго фактора перед опасным действием.
- [ ] `groups/attach-directory`, `groups/detach-directory` — передача группы
      каталогу и возврат под ручное управление.
- [ ] `workspace/members/delete` — удаление участника (в v2 есть отключение).
- [ ] `workspace/invites/info`, `/link`, `/resend` — сведения о приглашении,
      ссылка и повторная отправка.

### Пространства

- [ ] `personal-space/create`, `personal-space/info` — личное пространство.

### ИИ

- [ ] `ai/chats/upload` — вложение в разговоре.
- [ ] `ai/settings/models` — перечень моделей провайдера.
- [ ] `ai/settings/test` — проверка соединения с провайдером.

### Прочее

- [ ] `attachments/remove-icon` — снятие значка пространства или страницы.
- [ ] `files/public/{id}/{name}` — файл опубликованной страницы без входа.
- [ ] `version` — сведения о выпуске.
- [ ] `health/live` — проверка живости отдельно от готовности.
- [ ] `robots.txt` — правила обхода.
- [ ] `collab/stats` — счётчики каналов редактирования.

## Не переносится намеренно

- `sso/google/*` — вход через Google. Экземпляр работает без обращений в
  интернет, и такой вход этому противоречит.
- `workspace/check-hostname`, `workspace/entitlements` — облачные, в
  самостоятельном развёртывании смысла не имеют.
- `Schemas` у SCIM — описание схем, которое провайдеры читают необязательно;
  два маршрута обнаружения из трёх в v2 есть.
