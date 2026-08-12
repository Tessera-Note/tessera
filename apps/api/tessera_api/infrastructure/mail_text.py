"""Тексты писем на языке получателя.

Каталог перенесён из v1 (`integrations/transactional/mail-text.ts`) построчно.
Письма собираются на сервере, где словари клиента недоступны, поэтому каталог
свой, той же формы, что и коды отказов: ключ, подстановки в двойных фигурных
скобках, английский как запасной вариант.

Языки только те, что ведутся в репозитории. Для остальных девяти локалей письмо
приходит по-английски: сочинять перевод на языке, которого не знаешь, хуже, чем
оставить понятный английский.

Выделение внутри предложения снято намеренно: разметка внутри фразы заставляет
резать её на куски, а куски невозможно перевести на язык с другим порядком слов.
Название страницы и имя человека остаются подстановками.
"""

from __future__ import annotations

import re

EN = {
    "mail.access.writer": "edit",
    "mail.access.reader": "read",
    "mail.subject.invitation": "{{actor}} invited you to Tessera",
    "mail.subject.invitation_accepted": "{{name}} accepted your invitation to Tessera",
    "mail.subject.page_mention": "{{actor}} mentioned you on {{page}}",
    "mail.subject.permission_granted": "{{actor}} gave you {{access}} access to {{page}}",
    "mail.subject.page_update": "{{actor}} updated {{page}}",
    "mail.subject.digest": "Your digest: {{count}} page updates",
    "mail.subject.comment_mention": "{{actor}} mentioned you in a comment",
    "mail.subject.comment_created": "{{actor}} commented on {{page}}",
    "mail.subject.comment_resolved": "{{actor}} resolved a comment on {{page}}",
    "mail.subject.verification_expiring": "\"{{page}}\" needs to be verified again",
    "mail.subject.verification_expired": "Verification of \"{{page}}\" has expired",
    "mail.subject.approval_requested": "\"{{page}}\" is waiting for your approval",
    "mail.subject.approval_rejected": "\"{{page}}\" was sent back for revision",
    "mail.subject.password_changed": "Your password has been changed",
    "mail.subject.password_reset": "Reset your password",
    "mail.subject.mfa_reset": "Two-factor authentication was reset",
    "mail.greeting": "Hi",
    "mail.greeting_named": "Hi, {{name}}",
    "mail.footer": "Tessera · your team knowledge base",
    "mail.action.open_page": "Open page",
    "mail.action.view_comment": "View comment",
    "mail.action.review_page": "Review page",
    "mail.action.verify_page": "Verify page",
    "mail.action.set_password": "Set a new password",
    "mail.action.accept_invitation": "Accept invitation",
    "mail.page_mention.body": "{{actor}} mentioned you on {{page}}.",
    "mail.comment_created.body": "{{actor}} commented on {{page}}.",
    "mail.comment_mention.body": "{{actor}} mentioned you in a comment on {{page}}.",
    "mail.comment_resolved.body": "{{actor}} resolved a comment on {{page}}.",
    "mail.permission_granted.body": "{{actor}} gave you {{access}} access to {{page}}.",
    "mail.page_update.body": "{{actor}} updated {{page}} in {{space}}.",
    "mail.digest.body": "There have been {{count}} page updates since the last digest.",
    "mail.digest.edited_by": "Edited by {{names}}",
    "mail.approval_requested.body": "{{actor}} submitted {{page}} in {{space}} for your approval.",
    "mail.approval_rejected.body": "{{actor}} sent {{page}} in {{space}} back for revision.",
    "mail.verification_expiring.body": (
        "The page {{page}} in {{space}} needs to be verified again. "
        "Verification expires on {{date}}."
    ),
    "mail.verification_expired.body": (
        "Verification of {{page}} in {{space}} has expired. Verify the page "
        "again to confirm it is still correct."
    ),
    "mail.password_changed.body": "Your password has been changed.",
    "mail.password_changed.warning": (
        "If this was not you, contact a wiki administrator right away."
    ),
    "mail.forgot_password.body": "We received a request to reset your password.",
    "mail.forgot_password.note": (
        "The link is valid for 30 minutes. If you did not request it, ignore this email."
    ),
    "mail.mfa_reset.body": (
        "An administrator reset two-factor authentication for your "
        "account{{scope}}. A second factor is no longer required to sign in."
    ),
    "mail.mfa_reset.next": "Set two-factor authentication up again in your profile settings.",
    "mail.mfa_reset.warning": "If you did not ask for this, contact an administrator right away.",
    "mail.invitation.body": "You have been invited to Tessera, your team knowledge base.",
    "mail.invitation.note": "You received this email because someone on the team invited you.",
    "mail.invitation_accepted.body": (
        "{{name}} ({{email}}) accepted your invitation and is now part of the workspace."
    ),
}

RU = {
    "mail.access.writer": "правку",
    "mail.access.reader": "чтение",
    "mail.subject.invitation": "{{actor}} приглашает вас в Tessera",
    "mail.subject.invitation_accepted": "{{name}} принял ваше приглашение в Tessera",
    "mail.subject.page_mention": "{{actor}} упомянул вас на странице {{page}}",
    "mail.subject.permission_granted": "{{actor}} открыл вам доступ к «{{page}}» на {{access}}",
    "mail.subject.page_update": "{{actor}} изменил «{{page}}»",
    "mail.subject.digest": "Сводка: изменений страниц {{count}}",
    "mail.subject.comment_mention": "{{actor}} упомянул вас в комментарии",
    "mail.subject.comment_created": "{{actor}} оставил комментарий на «{{page}}»",
    "mail.subject.comment_resolved": "{{actor}} закрыл обсуждение на «{{page}}»",
    "mail.subject.verification_expiring": "«{{page}}» пора перепроверить",
    "mail.subject.verification_expired": "Срок подтверждения «{{page}}» истек",
    "mail.subject.approval_requested": "«{{page}}» ждет вашего утверждения",
    "mail.subject.approval_rejected": "«{{page}}» вернули на доработку",
    "mail.subject.password_changed": "Ваш пароль изменен",
    "mail.subject.password_reset": "Смена пароля",
    "mail.subject.mfa_reset": "Двухфакторная аутентификация сброшена",
    "mail.greeting": "Здравствуйте",
    "mail.greeting_named": "Здравствуйте, {{name}}",
    "mail.footer": "Tessera · база знаний вашей команды",
    "mail.action.open_page": "Открыть страницу",
    "mail.action.view_comment": "Посмотреть обсуждение",
    "mail.action.review_page": "Посмотреть страницу",
    "mail.action.verify_page": "Подтвердить страницу",
    "mail.action.set_password": "Задать новый пароль",
    "mail.action.accept_invitation": "Принять приглашение",
    "mail.page_mention.body": "{{actor}} упомянул вас на странице {{page}}.",
    "mail.comment_created.body": "{{actor}} оставил комментарий на «{{page}}».",
    "mail.comment_mention.body": "{{actor}} упомянул вас в комментарии на «{{page}}».",
    "mail.comment_resolved.body": "{{actor}} закрыл обсуждение на «{{page}}».",
    "mail.permission_granted.body": "{{actor}} открыл вам доступ к «{{page}}» на {{access}}.",
    "mail.page_update.body": "{{actor}} изменил «{{page}}» в пространстве {{space}}.",
    "mail.digest.body": "С прошлой сводки страницы менялись {{count}} раз.",
    "mail.digest.edited_by": "Правили: {{names}}",
    "mail.approval_requested.body": (
        "{{actor}} отправил «{{page}}» из пространства {{space}} вам на утверждение."
    ),
    "mail.approval_rejected.body": (
        "{{actor}} вернул «{{page}}» из пространства {{space}} на доработку."
    ),
    "mail.verification_expiring.body": (
        "Страницу «{{page}}» в пространстве {{space}} пора перепроверить. Срок "
        "подтверждения истекает {{date}}."
    ),
    "mail.verification_expired.body": (
        "Срок подтверждения «{{page}}» в пространстве {{space}} истек. "
        "Проверьте страницу заново и подтвердите, что она по-прежнему верна."
    ),
    "mail.password_changed.body": "Ваш пароль изменен.",
    "mail.password_changed.warning": (
        "Если это были не вы, немедленно обратитесь к администратору вики."
    ),
    "mail.forgot_password.body": "Мы получили просьбу сменить ваш пароль.",
    "mail.forgot_password.note": (
        "Ссылка действует 30 минут. Если вы этого не просили, просто не открывайте письмо."
    ),
    "mail.mfa_reset.body": (
        "Администратор сбросил двухфакторную аутентификацию для вашей учетной "
        "записи{{scope}}. Второй фактор для входа больше не нужен."
    ),
    "mail.mfa_reset.next": "Настройте двухфакторную аутентификацию заново в настройках профиля.",
    "mail.mfa_reset.warning": "Если вы этого не просили, немедленно обратитесь к администратору.",
    "mail.invitation.body": "Вас пригласили в Tessera, базу знаний вашей команды.",
    "mail.invitation.note": "Вы получили это письмо, потому что вас пригласил кто-то из команды.",
    "mail.invitation_accepted.body": (
        "{{name}} ({{email}}) принял ваше приглашение и теперь в рабочем пространстве."
    ),
}

UK = {
    "mail.access.writer": "правку",
    "mail.access.reader": "читання",
    "mail.subject.invitation": "{{actor}} запрошує вас до Tessera",
    "mail.subject.invitation_accepted": "{{name}} прийняв ваше запрошення до Tessera",
    "mail.subject.page_mention": "{{actor}} згадав вас на сторінці {{page}}",
    "mail.subject.permission_granted": "{{actor}} відкрив вам доступ до «{{page}}» на {{access}}",
    "mail.subject.page_update": "{{actor}} змінив «{{page}}»",
    "mail.subject.digest": "Зведення: змін сторінок {{count}}",
    "mail.subject.comment_mention": "{{actor}} згадав вас у коментарі",
    "mail.subject.comment_created": "{{actor}} залишив коментар на «{{page}}»",
    "mail.subject.comment_resolved": "{{actor}} закрив обговорення на «{{page}}»",
    "mail.subject.verification_expiring": "«{{page}}» час перевірити знову",
    "mail.subject.verification_expired": "Термін підтвердження «{{page}}» минув",
    "mail.subject.approval_requested": "«{{page}}» чекає вашого затвердження",
    "mail.subject.approval_rejected": "«{{page}}» повернули на доопрацювання",
    "mail.subject.password_changed": "Ваш пароль змінено",
    "mail.subject.password_reset": "Зміна пароля",
    "mail.subject.mfa_reset": "Двофакторну автентифікацію скинуто",
    "mail.greeting": "Вітаємо",
    "mail.greeting_named": "Вітаємо, {{name}}",
    "mail.footer": "Tessera · база знань вашої команди",
    "mail.action.open_page": "Відкрити сторінку",
    "mail.action.view_comment": "Переглянути обговорення",
    "mail.action.review_page": "Переглянути сторінку",
    "mail.action.verify_page": "Підтвердити сторінку",
    "mail.action.set_password": "Задати новий пароль",
    "mail.action.accept_invitation": "Прийняти запрошення",
    "mail.page_mention.body": "{{actor}} згадав вас на сторінці {{page}}.",
    "mail.comment_created.body": "{{actor}} залишив коментар на «{{page}}».",
    "mail.comment_mention.body": "{{actor}} згадав вас у коментарі на «{{page}}».",
    "mail.comment_resolved.body": "{{actor}} закрив обговорення на «{{page}}».",
    "mail.permission_granted.body": "{{actor}} відкрив вам доступ до «{{page}}» на {{access}}.",
    "mail.page_update.body": "{{actor}} змінив «{{page}}» у просторі {{space}}.",
    "mail.digest.body": "Від минулої зведення сторінки змінювались {{count}} разів.",
    "mail.digest.edited_by": "Правили: {{names}}",
    "mail.approval_requested.body": (
        "{{actor}} надіслав «{{page}}» з простору {{space}} вам на затвердження."
    ),
    "mail.approval_rejected.body": (
        "{{actor}} повернув «{{page}}» з простору {{space}} на доопрацювання."
    ),
    "mail.verification_expiring.body": (
        "Сторінку «{{page}}» у просторі {{space}} час перевірити знову. Термін "
        "підтвердження спливає {{date}}."
    ),
    "mail.verification_expired.body": (
        "Термін підтвердження «{{page}}» у просторі {{space}} минув. Перевірте "
        "сторінку заново та підтвердіть, що вона й досі правильна."
    ),
    "mail.password_changed.body": "Ваш пароль змінено.",
    "mail.password_changed.warning": (
        "Якщо це були не ви, негайно зверніться до адміністратора вікі."
    ),
    "mail.forgot_password.body": "Ми отримали прохання змінити ваш пароль.",
    "mail.forgot_password.note": (
        "Посилання діє 30 хвилин. Якщо ви цього не просили, просто не відкривайте лист."
    ),
    "mail.mfa_reset.body": (
        "Адміністратор скинув двофакторну автентифікацію для вашого облікового "
        "запису{{scope}}. Другий фактор для входу більше не потрібен."
    ),
    "mail.mfa_reset.next": "Налаштуйте двофакторну автентифікацію заново в налаштуваннях профілю.",
    "mail.mfa_reset.warning": "Якщо ви цього не просили, негайно зверніться до адміністратора.",
    "mail.invitation.body": "Вас запросили до Tessera, бази знань вашої команди.",
    "mail.invitation.note": "Ви отримали цей лист, бо вас запросив хтось із команди.",
    "mail.invitation_accepted.body": (
        "{{name}} ({{email}}) прийняв ваше запрошення і тепер у робочому просторі."
    ),
}

#: Каталоги по локали. Ключ совпадает с кодом локали клиента.
CATALOGUE = {
    "en-US": EN,
    "ru-RU": RU,
    "uk-UA": UK,
}

MAIL_LOCALES = tuple(CATALOGUE)

#: Запасной язык. Английский, а не язык рабочего пространства: он один и тот же
#: для всех установок, а язык пространства бывает не задан вовсе.
FALLBACK = "en-US"

_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def mail_text(locale: str | None, key: str, params: dict | None = None) -> str:
    """Строка письма на языке получателя.

    Неизвестный язык и неизвестный ключ не роняют отправку. Письмо о смене
    пароля важнее, чем его язык, и отказ здесь означал бы, что человек не узнал
    о смене вовсе.

    Незаполненная подстановка остаётся как есть, а не превращается в пустоту:
    «{{page}}» в письме читается как ошибка и её чинят, пустое место — как
    странная формулировка, и её не замечают.
    """
    catalogue = CATALOGUE.get((locale or "").strip() or FALLBACK) or CATALOGUE[FALLBACK]
    template = catalogue.get(key) or CATALOGUE[FALLBACK].get(key) or key

    values = params or {}

    def replace(match: re.Match) -> str:
        name = match.group(1)
        return str(values[name]) if name in values else match.group(0)

    return _PLACEHOLDER.sub(replace, template)
