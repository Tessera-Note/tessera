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
- [x] `pages/sidebar-pages` — ветвь дерева для боковой панели.
- [x] `pages/backlinks-count` — счётчик обратных ссылок.
- [x] `pages/transclusion/lookup`, `/references`, `/unsync-reference` —
      включение куска чужой страницы. Узлы схемы есть, маршрутов нет.
- [x] `favorites/ids` — только идентификаторы избранного.

### Ссылки общего доступа

- [x] `shares/update` — правка настроек ссылки (подстраницы, индексация).
- [x] `shares/tree` — дерево страниц внутри опубликованной ветви.
- [x] `shares/page-info`, `shares/info` — сведения об опубликованной странице.
- [x] `shares/transclusion/lookup` — включения внутри опубликованной страницы.
- [x] `search/share-search` — поиск внутри опубликованной ветви.

### Учётные записи и охрана

- [x] `sessions`, `sessions/revoke`, `sessions/revoke-all` — свои сеансы и их
      отзыв.
- [x] `sso/providers`, `sso/create`, `sso/update`, `sso/delete`, `sso/info`,
      `sso/unlink` — управление провайдерами входа. Сам вход через них работает.
- [x] `scim-tokens`, `/create`, `/revoke`, `/update` — токены синхронизации
      каталога. Служба в v2 есть, маршрутов нет.
- [x] `mfa/validate-access` — проверка второго фактора перед опасным действием.
- [x] `groups/attach-directory`, `groups/detach-directory` — передача группы
      каталогу и возврат под ручное управление.
- [x] `workspace/members/delete` — удаление участника (в v2 есть отключение).
- [x] `workspace/invites/info`, `/link`, `/resend` — сведения о приглашении,
      ссылка и повторная отправка.

### Пространства

- [x] `personal-space/create`, `personal-space/info` — личное пространство.

### ИИ

- [x] `ai/settings/models` — перечень моделей провайдера.
- [x] `ai/settings/test` — проверка соединения с провайдером.

### Прочее

Про размещение. `robots.txt` в v2 отдаёт веб-приложение, а не API: за обратным
прокси всё, кроме `/api`, идёт туда, и файлу место среди статики. `collab/stats`
живёт в сервисе совместного редактирования: соединения и документы держит он, и
спрашивать о них соседа значило бы отвечать по памяти чужого процесса.

- [x] `attachments/remove-icon` — снятие значка пространства или страницы.
- [x] `files/public/{id}/{name}` — файл опубликованной страницы без входа.
- [x] `version` — сведения о выпуске.
- [x] `health/live` — проверка живости отдельно от готовности.
- [x] `robots.txt` — правила обхода.
- [x] `collab/stats` — счётчики каналов редактирования.

## Не переносится намеренно

- `sso/google/*` — вход через Google. Экземпляр работает без обращений в
  интернет, и такой вход этому противоречит.
- `workspace/check-hostname`, `workspace/entitlements` — облачные, в
  самостоятельном развёртывании смысла не имеют.
- `Schemas` у SCIM — описание схем, которое провайдеры читают необязательно;
  два маршрута обнаружения из трёх в v2 есть.
- `labels/info` — в v1 этот маршрут закомментирован и не работает. Сверка
  считала его существующим по тексту файла; проверять было нечего.
- `ai/chats/upload` — в v1 это заглушка: маршрут отвечает отказом
  «вложения не поддерживаются» и ничего не делает. Повторять её значило бы
  завести стаб в продакшене, что здесь запрещено.
