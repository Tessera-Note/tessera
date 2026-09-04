"""Тексты писем на языке получателя.

Каталог перенесён из v1 (`integrations/transactional/mail-text.ts`) построчно.
Письма собираются на сервере, где словари клиента недоступны, поэтому каталог
свой, той же формы, что и коды отказов: ключ, подстановки в двойных фигурных
скобках, английский как запасной вариант.

Языков двенадцать — ровно те же, что у словарей экранов. Список сверяется
проверкой: расхождение выглядит так, что человек ведёт вику на своём языке, а
письмо о смене пароля приходит по-английски, и отказом это не проявляется.

Переводы сделаны в работе и носителями языка не вычитаны — это надо знать,
принимая результат. Незаведённый язык по-прежнему берёт английский: отказ здесь
означал бы, что человек не узнал о смене пароля вовсе.

Слово о виде доступа (`mail.access.*`) подставляется в предложение, и каждый
язык строит это предложение под себя: где падеж не подходит, вид доступа вынесен
после двоеточия. Переводить эти два ключа в отрыве от предложения нельзя.

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
DE = {
    "mail.access.writer": "Bearbeiten",
    "mail.access.reader": "Lesen",
    "mail.subject.invitation": "{{actor}} hat Sie zu Tessera eingeladen",
    "mail.subject.invitation_accepted": "{{name}} hat Ihre Einladung zu Tessera angenommen",
    "mail.subject.page_mention": "{{actor}} hat Sie auf {{page}} erwähnt",
    "mail.subject.permission_granted": (
        "{{actor}} hat Ihnen Zugriff auf {{page}} gegeben: {{access}}"
    ),
    "mail.subject.page_update": "{{actor}} hat {{page}} geändert",
    "mail.subject.digest": "Ihre Übersicht: {{count}} Seitenänderungen",
    "mail.subject.comment_mention": "{{actor}} hat Sie in einem Kommentar erwähnt",
    "mail.subject.comment_created": "{{actor}} hat {{page}} kommentiert",
    "mail.subject.comment_resolved": "{{actor}} hat ein Kommentarthema auf {{page}} geschlossen",
    "mail.subject.verification_expiring": "„{{page}}“ muss erneut geprüft werden",
    "mail.subject.verification_expired": "Die Prüfung von „{{page}}“ ist abgelaufen",
    "mail.subject.approval_requested": "„{{page}}“ wartet auf Ihre Freigabe",
    "mail.subject.approval_rejected": "„{{page}}“ wurde zur Überarbeitung zurückgegeben",
    "mail.subject.password_changed": "Ihr Passwort wurde geändert",
    "mail.subject.password_reset": "Passwort zurücksetzen",
    "mail.subject.mfa_reset": "Die Zwei-Faktor-Authentifizierung wurde zurückgesetzt",
    "mail.greeting": "Hallo",
    "mail.greeting_named": "Hallo {{name}}",
    "mail.footer": "Tessera · die Wissensdatenbank Ihres Teams",
    "mail.action.open_page": "Seite öffnen",
    "mail.action.view_comment": "Kommentar ansehen",
    "mail.action.review_page": "Seite prüfen",
    "mail.action.verify_page": "Seite bestätigen",
    "mail.action.set_password": "Neues Passwort festlegen",
    "mail.action.accept_invitation": "Einladung annehmen",
    "mail.page_mention.body": "{{actor}} hat Sie auf {{page}} erwähnt.",
    "mail.comment_created.body": "{{actor}} hat {{page}} kommentiert.",
    "mail.comment_mention.body": "{{actor}} hat Sie in einem Kommentar auf {{page}} erwähnt.",
    "mail.comment_resolved.body": "{{actor}} hat ein Kommentarthema auf {{page}} geschlossen.",
    "mail.permission_granted.body": "{{actor}} hat Ihnen Zugriff auf {{page}} gegeben: {{access}}.",
    "mail.page_update.body": "{{actor}} hat {{page}} in {{space}} geändert.",
    "mail.digest.body": "Seit der letzten Übersicht gab es {{count}} Seitenänderungen.",
    "mail.digest.edited_by": "Bearbeitet von {{names}}",
    "mail.approval_requested.body": "{{actor}} hat {{page}} in {{space}} zur Freigabe eingereicht.",
    "mail.approval_rejected.body": (
        "{{actor}} hat {{page}} in {{space}} zur Überarbeitung zurückgegeben."
    ),
    "mail.verification_expiring.body": (
        "Die Seite {{page}} in {{space}} muss erneut geprüft werden. Die Prüfung läuft am {{date}} "
        "ab."
    ),
    "mail.verification_expired.body": (
        "Die Prüfung von {{page}} in {{space}} ist abgelaufen. Bestätigen Sie die Seite erneut, um "
        "zu zeigen, dass sie weiterhin stimmt."
    ),
    "mail.password_changed.body": "Ihr Passwort wurde geändert.",
    "mail.password_changed.warning": (
        "Waren Sie das nicht, wenden Sie sich sofort an die Administration des Wikis."
    ),
    "mail.forgot_password.body": "Wir haben eine Anfrage erhalten, Ihr Passwort zurückzusetzen.",
    "mail.forgot_password.note": (
        "Der Link ist 30 Minuten gültig. Haben Sie ihn nicht angefordert, ignorieren Sie diese "
        "E-Mail."
    ),
    "mail.mfa_reset.body": (
        "Die Administration hat die Zwei-Faktor-Authentifizierung für Ihr Konto{{scope}} "
        "zurückgesetzt. Ein zweiter Faktor ist zum Anmelden nicht mehr nötig."
    ),
    "mail.mfa_reset.next": (
        "Richten Sie die Zwei-Faktor-Authentifizierung in Ihren Profileinstellungen erneut ein."
    ),
    "mail.mfa_reset.warning": (
        "Haben Sie das nicht verlangt, wenden Sie sich sofort an die Administration."
    ),
    "mail.invitation.body": "Sie wurden zu Tessera eingeladen, der Wissensdatenbank Ihres Teams.",
    "mail.invitation.note": (
        "Sie erhalten diese E-Mail, weil jemand aus dem Team Sie eingeladen hat."
    ),
    "mail.invitation_accepted.body": (
        "{{name}} ({{email}}) hat Ihre Einladung angenommen und gehört jetzt zum Arbeitsbereich."
    ),
}

ES = {
    "mail.access.writer": "edición",
    "mail.access.reader": "lectura",
    "mail.subject.invitation": "{{actor}} te ha invitado a Tessera",
    "mail.subject.invitation_accepted": "{{name}} ha aceptado tu invitación a Tessera",
    "mail.subject.page_mention": "{{actor}} te ha mencionado en {{page}}",
    "mail.subject.permission_granted": "{{actor}} te ha dado acceso de {{access}} a {{page}}",
    "mail.subject.page_update": "{{actor}} ha modificado {{page}}",
    "mail.subject.digest": "Tu resumen: {{count}} cambios en páginas",
    "mail.subject.comment_mention": "{{actor}} te ha mencionado en un comentario",
    "mail.subject.comment_created": "{{actor}} ha comentado en {{page}}",
    "mail.subject.comment_resolved": "{{actor}} ha resuelto un comentario en {{page}}",
    "mail.subject.verification_expiring": "«{{page}}» necesita verificarse de nuevo",
    "mail.subject.verification_expired": "La verificación de «{{page}}» ha caducado",
    "mail.subject.approval_requested": "«{{page}}» espera tu aprobación",
    "mail.subject.approval_rejected": "«{{page}}» se ha devuelto para revisión",
    "mail.subject.password_changed": "Tu contraseña ha cambiado",
    "mail.subject.password_reset": "Restablece tu contraseña",
    "mail.subject.mfa_reset": "Se ha restablecido la autenticación en dos pasos",
    "mail.greeting": "Hola",
    "mail.greeting_named": "Hola, {{name}}",
    "mail.footer": "Tessera · la base de conocimiento de tu equipo",
    "mail.action.open_page": "Abrir página",
    "mail.action.view_comment": "Ver comentario",
    "mail.action.review_page": "Revisar página",
    "mail.action.verify_page": "Verificar página",
    "mail.action.set_password": "Establecer una contraseña nueva",
    "mail.action.accept_invitation": "Aceptar invitación",
    "mail.page_mention.body": "{{actor}} te ha mencionado en {{page}}.",
    "mail.comment_created.body": "{{actor}} ha comentado en {{page}}.",
    "mail.comment_mention.body": "{{actor}} te ha mencionado en un comentario de {{page}}.",
    "mail.comment_resolved.body": "{{actor}} ha resuelto un comentario en {{page}}.",
    "mail.permission_granted.body": "{{actor}} te ha dado acceso de {{access}} a {{page}}.",
    "mail.page_update.body": "{{actor}} ha modificado {{page}} en {{space}}.",
    "mail.digest.body": "Ha habido {{count}} cambios en páginas desde el último resumen.",
    "mail.digest.edited_by": "Editado por {{names}}",
    "mail.approval_requested.body": (
        "{{actor}} ha enviado {{page}} de {{space}} para tu aprobación."
    ),
    "mail.approval_rejected.body": "{{actor}} ha devuelto {{page}} de {{space}} para revisión.",
    "mail.verification_expiring.body": (
        "La página {{page}} de {{space}} necesita verificarse de nuevo. La verificación caduca el "
        "{{date}}."
    ),
    "mail.verification_expired.body": (
        "La verificación de {{page}} en {{space}} ha caducado. Verifica la página de nuevo para "
        "confirmar que sigue siendo correcta."
    ),
    "mail.password_changed.body": "Tu contraseña ha cambiado.",
    "mail.password_changed.warning": (
        "Si no has sido tú, ponte en contacto de inmediato con la administración del wiki."
    ),
    "mail.forgot_password.body": "Hemos recibido una solicitud para restablecer tu contraseña.",
    "mail.forgot_password.note": (
        "El enlace es válido durante 30 minutos. Si no lo has solicitado, ignora este correo."
    ),
    "mail.mfa_reset.body": (
        "La administración ha restablecido la autenticación en dos pasos de tu cuenta{{scope}}. Ya "
        "no hace falta un segundo factor para entrar."
    ),
    "mail.mfa_reset.next": (
        "Vuelve a configurar la autenticación en dos pasos en los ajustes de tu perfil."
    ),
    "mail.mfa_reset.warning": (
        "Si no lo has pedido, ponte en contacto de inmediato con la administración."
    ),
    "mail.invitation.body": "Te han invitado a Tessera, la base de conocimiento de tu equipo.",
    "mail.invitation.note": "Recibes este correo porque alguien del equipo te ha invitado.",
    "mail.invitation_accepted.body": (
        "{{name}} ({{email}}) ha aceptado tu invitación y ya forma parte del espacio de trabajo."
    ),
}

FR = {
    "mail.access.writer": "modification",
    "mail.access.reader": "lecture",
    "mail.subject.invitation": "{{actor}} vous a invité sur Tessera",
    "mail.subject.invitation_accepted": "{{name}} a accepté votre invitation sur Tessera",
    "mail.subject.page_mention": "{{actor}} vous a mentionné sur {{page}}",
    "mail.subject.permission_granted": "{{actor}} vous a donné l’accès en {{access}} à {{page}}",
    "mail.subject.page_update": "{{actor}} a modifié {{page}}",
    "mail.subject.digest": "Votre récapitulatif : {{count}} modifications de pages",
    "mail.subject.comment_mention": "{{actor}} vous a mentionné dans un commentaire",
    "mail.subject.comment_created": "{{actor}} a commenté {{page}}",
    "mail.subject.comment_resolved": "{{actor}} a résolu un commentaire sur {{page}}",
    "mail.subject.verification_expiring": "« {{page}} » doit être vérifiée à nouveau",
    "mail.subject.verification_expired": "La vérification de « {{page}} » a expiré",
    "mail.subject.approval_requested": "« {{page}} » attend votre approbation",
    "mail.subject.approval_rejected": "« {{page}} » a été renvoyée pour révision",
    "mail.subject.password_changed": "Votre mot de passe a été modifié",
    "mail.subject.password_reset": "Réinitialisez votre mot de passe",
    "mail.subject.mfa_reset": "L’authentification à deux facteurs a été réinitialisée",
    "mail.greeting": "Bonjour",
    "mail.greeting_named": "Bonjour {{name}}",
    "mail.footer": "Tessera · la base de connaissances de votre équipe",
    "mail.action.open_page": "Ouvrir la page",
    "mail.action.view_comment": "Voir le commentaire",
    "mail.action.review_page": "Examiner la page",
    "mail.action.verify_page": "Vérifier la page",
    "mail.action.set_password": "Définir un nouveau mot de passe",
    "mail.action.accept_invitation": "Accepter l’invitation",
    "mail.page_mention.body": "{{actor}} vous a mentionné sur {{page}}.",
    "mail.comment_created.body": "{{actor}} a commenté {{page}}.",
    "mail.comment_mention.body": "{{actor}} vous a mentionné dans un commentaire sur {{page}}.",
    "mail.comment_resolved.body": "{{actor}} a résolu un commentaire sur {{page}}.",
    "mail.permission_granted.body": "{{actor}} vous a donné l’accès en {{access}} à {{page}}.",
    "mail.page_update.body": "{{actor}} a modifié {{page}} dans {{space}}.",
    "mail.digest.body": (
        "Il y a eu {{count}} modifications de pages depuis le dernier récapitulatif."
    ),
    "mail.digest.edited_by": "Modifiée par {{names}}",
    "mail.approval_requested.body": "{{actor}} a soumis {{page}} de {{space}} à votre approbation.",
    "mail.approval_rejected.body": "{{actor}} a renvoyé {{page}} de {{space}} pour révision.",
    "mail.verification_expiring.body": (
        "La page {{page}} de {{space}} doit être vérifiée à nouveau. La vérification expire le "
        "{{date}}."
    ),
    "mail.verification_expired.body": (
        "La vérification de {{page}} dans {{space}} a expiré. Vérifiez la page à nouveau pour "
        "confirmer qu’elle est toujours exacte."
    ),
    "mail.password_changed.body": "Votre mot de passe a été modifié.",
    "mail.password_changed.warning": (
        "Si ce n’était pas vous, contactez immédiatement l’administration du wiki."
    ),
    "mail.forgot_password.body": (
        "Nous avons reçu une demande de réinitialisation de votre mot de passe."
    ),
    "mail.forgot_password.note": (
        "Le lien est valable 30 minutes. Si vous ne l’avez pas demandé, ignorez cet e-mail."
    ),
    "mail.mfa_reset.body": (
        "L’administration a réinitialisé l’authentification à deux facteurs de votre "
        "compte{{scope}}. Un deuxième facteur n’est plus requis pour se connecter."
    ),
    "mail.mfa_reset.next": (
        "Configurez à nouveau l’authentification à deux facteurs dans les paramètres de votre "
        "profil."
    ),
    "mail.mfa_reset.warning": (
        "Si vous ne l’avez pas demandé, contactez immédiatement l’administration."
    ),
    "mail.invitation.body": (
        "Vous avez été invité sur Tessera, la base de connaissances de votre équipe."
    ),
    "mail.invitation.note": (
        "Vous recevez cet e-mail parce qu’une personne de l’équipe vous a invité."
    ),
    "mail.invitation_accepted.body": (
        "{{name}} ({{email}}) a accepté votre invitation et fait désormais partie de l’espace de "
        "travail."
    ),
}

IT = {
    "mail.access.writer": "modifica",
    "mail.access.reader": "lettura",
    "mail.subject.invitation": "{{actor}} ti ha invitato su Tessera",
    "mail.subject.invitation_accepted": "{{name}} ha accettato il tuo invito su Tessera",
    "mail.subject.page_mention": "{{actor}} ti ha menzionato su {{page}}",
    "mail.subject.permission_granted": "{{actor}} ti ha dato accesso in {{access}} a {{page}}",
    "mail.subject.page_update": "{{actor}} ha modificato {{page}}",
    "mail.subject.digest": "Il tuo riepilogo: {{count}} modifiche alle pagine",
    "mail.subject.comment_mention": "{{actor}} ti ha menzionato in un commento",
    "mail.subject.comment_created": "{{actor}} ha commentato {{page}}",
    "mail.subject.comment_resolved": "{{actor}} ha risolto un commento su {{page}}",
    "mail.subject.verification_expiring": "«{{page}}» deve essere verificata di nuovo",
    "mail.subject.verification_expired": "La verifica di «{{page}}» è scaduta",
    "mail.subject.approval_requested": "«{{page}}» attende la tua approvazione",
    "mail.subject.approval_rejected": "«{{page}}» è stata rimandata in revisione",
    "mail.subject.password_changed": "La tua password è stata cambiata",
    "mail.subject.password_reset": "Reimposta la password",
    "mail.subject.mfa_reset": "L’autenticazione a due fattori è stata reimpostata",
    "mail.greeting": "Ciao",
    "mail.greeting_named": "Ciao {{name}}",
    "mail.footer": "Tessera · la base di conoscenza del tuo team",
    "mail.action.open_page": "Apri la pagina",
    "mail.action.view_comment": "Vedi il commento",
    "mail.action.review_page": "Esamina la pagina",
    "mail.action.verify_page": "Verifica la pagina",
    "mail.action.set_password": "Imposta una nuova password",
    "mail.action.accept_invitation": "Accetta l’invito",
    "mail.page_mention.body": "{{actor}} ti ha menzionato su {{page}}.",
    "mail.comment_created.body": "{{actor}} ha commentato {{page}}.",
    "mail.comment_mention.body": "{{actor}} ti ha menzionato in un commento su {{page}}.",
    "mail.comment_resolved.body": "{{actor}} ha risolto un commento su {{page}}.",
    "mail.permission_granted.body": "{{actor}} ti ha dato accesso in {{access}} a {{page}}.",
    "mail.page_update.body": "{{actor}} ha modificato {{page}} in {{space}}.",
    "mail.digest.body": "Dall’ultimo riepilogo ci sono state {{count}} modifiche alle pagine.",
    "mail.digest.edited_by": "Modificata da {{names}}",
    "mail.approval_requested.body": (
        "{{actor}} ha inviato {{page}} di {{space}} per la tua approvazione."
    ),
    "mail.approval_rejected.body": "{{actor}} ha rimandato {{page}} di {{space}} in revisione.",
    "mail.verification_expiring.body": (
        "La pagina {{page}} in {{space}} deve essere verificata di nuovo. La verifica scade il "
        "{{date}}."
    ),
    "mail.verification_expired.body": (
        "La verifica di {{page}} in {{space}} è scaduta. Verifica di nuovo la pagina per "
        "confermare che sia ancora corretta."
    ),
    "mail.password_changed.body": "La tua password è stata cambiata.",
    "mail.password_changed.warning": (
        "Se non sei stato tu, contatta subito l’amministrazione del wiki."
    ),
    "mail.forgot_password.body": "Abbiamo ricevuto una richiesta di reimpostazione della password.",
    "mail.forgot_password.note": (
        "Il link è valido per 30 minuti. Se non l’hai richiesto, ignora questa email."
    ),
    "mail.mfa_reset.body": (
        "L’amministrazione ha reimpostato l’autenticazione a due fattori del tuo account{{scope}}. "
        "Per accedere non serve più un secondo fattore."
    ),
    "mail.mfa_reset.next": (
        "Configura di nuovo l’autenticazione a due fattori nelle impostazioni del profilo."
    ),
    "mail.mfa_reset.warning": "Se non l’hai chiesto tu, contatta subito l’amministrazione.",
    "mail.invitation.body": "Sei stato invitato su Tessera, la base di conoscenza del tuo team.",
    "mail.invitation.note": "Ricevi questa email perché qualcuno del team ti ha invitato.",
    "mail.invitation_accepted.body": (
        "{{name}} ({{email}}) ha accettato il tuo invito e ora fa parte dello spazio di lavoro."
    ),
}

JA = {
    "mail.access.writer": "編集",
    "mail.access.reader": "閲覧",
    "mail.subject.invitation": "{{actor}} さんが Tessera に招待しました",
    "mail.subject.invitation_accepted": "{{name}} さんが Tessera への招待を承諾しました",
    "mail.subject.page_mention": "{{actor}} さんが {{page}} であなたに言及しました",
    "mail.subject.permission_granted": "{{actor}} さんが {{page}} の{{access}}権限を付与しました",
    "mail.subject.page_update": "{{actor}} さんが {{page}} を更新しました",
    "mail.subject.digest": "ダイジェスト: ページの更新 {{count}} 件",
    "mail.subject.comment_mention": "{{actor}} さんがコメントであなたに言及しました",
    "mail.subject.comment_created": "{{actor}} さんが {{page}} にコメントしました",
    "mail.subject.comment_resolved": "{{actor}} さんが {{page}} のコメントを解決しました",
    "mail.subject.verification_expiring": "「{{page}}」の再確認が必要です",
    "mail.subject.verification_expired": "「{{page}}」の確認期限が切れました",
    "mail.subject.approval_requested": "「{{page}}」が承認を待っています",
    "mail.subject.approval_rejected": "「{{page}}」が修正のために差し戻されました",
    "mail.subject.password_changed": "パスワードが変更されました",
    "mail.subject.password_reset": "パスワードの再設定",
    "mail.subject.mfa_reset": "二要素認証がリセットされました",
    "mail.greeting": "こんにちは",
    "mail.greeting_named": "{{name}} さん、こんにちは",
    "mail.footer": "Tessera · チームのナレッジベース",
    "mail.action.open_page": "ページを開く",
    "mail.action.view_comment": "コメントを見る",
    "mail.action.review_page": "ページを確認する",
    "mail.action.verify_page": "ページを承認する",
    "mail.action.set_password": "新しいパスワードを設定する",
    "mail.action.accept_invitation": "招待を承諾する",
    "mail.page_mention.body": "{{actor}} さんが {{page}} であなたに言及しました。",
    "mail.comment_created.body": "{{actor}} さんが {{page}} にコメントしました。",
    "mail.comment_mention.body": "{{actor}} さんが {{page}} のコメントであなたに言及しました。",
    "mail.comment_resolved.body": "{{actor}} さんが {{page}} のコメントを解決しました。",
    "mail.permission_granted.body": "{{actor}} さんが {{page}} の{{access}}権限を付与しました。",
    "mail.page_update.body": "{{actor}} さんが {{space}} の {{page}} を更新しました。",
    "mail.digest.body": "前回のダイジェスト以降、ページの更新が {{count}} 件ありました。",
    "mail.digest.edited_by": "編集者: {{names}}",
    "mail.approval_requested.body": (
        "{{actor}} さんが {{space}} の {{page}} を承認のために提出しました。"
    ),
    "mail.approval_rejected.body": (
        "{{actor}} さんが {{space}} の {{page}} を修正のために差し戻しました。"
    ),
    "mail.verification_expiring.body": (
        "{{space}} のページ {{page}} は再確認が必要です。確認期限は {{date}} です。"
    ),
    "mail.verification_expired.body": (
        "{{space}} の {{page}} の確認期限が切れました。内容が今も正しいことを確かめ、ページを再度承"
        "認してください。"
    ),
    "mail.password_changed.body": "パスワードが変更されました。",
    "mail.password_changed.warning": "心当たりがない場合は、すぐにウィキの管理者にご連絡ください。",
    "mail.forgot_password.body": "パスワード再設定の依頼を受け取りました。",
    "mail.forgot_password.note": (
        "リンクの有効期限は 30 分です。依頼した覚えがない場合は、このメールを無視してください。"
    ),
    "mail.mfa_reset.body": (
        "管理者があなたのアカウント{{scope}}の二要素認証をリセットしました。サインインに二つ目の要"
        "素は不要になりました。"
    ),
    "mail.mfa_reset.next": "プロフィール設定から二要素認証を設定し直してください。",
    "mail.mfa_reset.warning": "依頼した覚えがない場合は、すぐに管理者にご連絡ください。",
    "mail.invitation.body": "チームのナレッジベース Tessera に招待されました。",
    "mail.invitation.note": "チームの誰かがあなたを招待したため、このメールが届いています。",
    "mail.invitation_accepted.body": (
        "{{name}}（{{email}}）さんが招待を承諾し、ワークスペースの一員になりました。"
    ),
}

KO = {
    "mail.access.writer": "편집",
    "mail.access.reader": "읽기",
    "mail.subject.invitation": "{{actor}}님이 Tessera에 초대했습니다",
    "mail.subject.invitation_accepted": "{{name}}님이 Tessera 초대를 수락했습니다",
    "mail.subject.page_mention": "{{actor}}님이 {{page}}에서 회원님을 언급했습니다",
    "mail.subject.permission_granted": "{{actor}}님이 {{page}}에 대한 {{access}} 권한을 주었습니다",
    "mail.subject.page_update": "{{actor}}님이 {{page}}을(를) 수정했습니다",
    "mail.subject.digest": "요약: 페이지 변경 {{count}}건",
    "mail.subject.comment_mention": "{{actor}}님이 댓글에서 회원님을 언급했습니다",
    "mail.subject.comment_created": "{{actor}}님이 {{page}}에 댓글을 남겼습니다",
    "mail.subject.comment_resolved": "{{actor}}님이 {{page}}의 댓글을 해결했습니다",
    "mail.subject.verification_expiring": "「{{page}}」을(를) 다시 확인해야 합니다",
    "mail.subject.verification_expired": "「{{page}}」의 확인 기한이 지났습니다",
    "mail.subject.approval_requested": "「{{page}}」이(가) 승인을 기다리고 있습니다",
    "mail.subject.approval_rejected": "「{{page}}」이(가) 수정을 위해 반려되었습니다",
    "mail.subject.password_changed": "비밀번호가 변경되었습니다",
    "mail.subject.password_reset": "비밀번호 재설정",
    "mail.subject.mfa_reset": "2단계 인증이 초기화되었습니다",
    "mail.greeting": "안녕하세요",
    "mail.greeting_named": "{{name}}님, 안녕하세요",
    "mail.footer": "Tessera · 팀의 지식 베이스",
    "mail.action.open_page": "페이지 열기",
    "mail.action.view_comment": "댓글 보기",
    "mail.action.review_page": "페이지 검토",
    "mail.action.verify_page": "페이지 확인",
    "mail.action.set_password": "새 비밀번호 설정",
    "mail.action.accept_invitation": "초대 수락",
    "mail.page_mention.body": "{{actor}}님이 {{page}}에서 회원님을 언급했습니다.",
    "mail.comment_created.body": "{{actor}}님이 {{page}}에 댓글을 남겼습니다.",
    "mail.comment_mention.body": "{{actor}}님이 {{page}}의 댓글에서 회원님을 언급했습니다.",
    "mail.comment_resolved.body": "{{actor}}님이 {{page}}의 댓글을 해결했습니다.",
    "mail.permission_granted.body": "{{actor}}님이 {{page}}에 대한 {{access}} 권한을 주었습니다.",
    "mail.page_update.body": "{{actor}}님이 {{space}}의 {{page}}을(를) 수정했습니다.",
    "mail.digest.body": "지난 요약 이후 페이지 변경이 {{count}}건 있었습니다.",
    "mail.digest.edited_by": "편집: {{names}}",
    "mail.approval_requested.body": "{{actor}}님이 {{space}}의 {{page}}을(를) 승인 요청했습니다.",
    "mail.approval_rejected.body": (
        "{{actor}}님이 {{space}}의 {{page}}을(를) 수정을 위해 반려했습니다."
    ),
    "mail.verification_expiring.body": (
        "{{space}}의 페이지 {{page}}을(를) 다시 확인해야 합니다. 확인 기한은 {{date}}입니다."
    ),
    "mail.verification_expired.body": (
        "{{space}}의 {{page}} 확인 기한이 지났습니다. 내용이 여전히 정확한지 확인하고 페이지를 "
        "다시 승인해 주세요."
    ),
    "mail.password_changed.body": "비밀번호가 변경되었습니다.",
    "mail.password_changed.warning": "본인이 아니라면 즉시 위키 관리자에게 알려 주세요.",
    "mail.forgot_password.body": "비밀번호 재설정 요청을 받았습니다.",
    "mail.forgot_password.note": (
        "링크는 30분 동안 유효합니다. 요청한 적이 없다면 이 메일을 무시하세요."
    ),
    "mail.mfa_reset.body": (
        "관리자가 회원님 계정{{scope}}의 2단계 인증을 초기화했습니다. 이제 로그인에 두 번째 인증 "
        "수단이 필요하지 않습니다."
    ),
    "mail.mfa_reset.next": "프로필 설정에서 2단계 인증을 다시 설정하세요.",
    "mail.mfa_reset.warning": "요청한 적이 없다면 즉시 관리자에게 알려 주세요.",
    "mail.invitation.body": "팀의 지식 베이스 Tessera에 초대되었습니다.",
    "mail.invitation.note": "팀의 누군가가 회원님을 초대했기 때문에 이 메일을 받았습니다.",
    "mail.invitation_accepted.body": (
        "{{name}}({{email}})님이 초대를 수락하고 이제 워크스페이스의 일원이 되었습니다."
    ),
}

NL = {
    "mail.access.writer": "bewerken",
    "mail.access.reader": "lezen",
    "mail.subject.invitation": "{{actor}} heeft je uitgenodigd voor Tessera",
    "mail.subject.invitation_accepted": "{{name}} heeft je uitnodiging voor Tessera geaccepteerd",
    "mail.subject.page_mention": "{{actor}} heeft je genoemd op {{page}}",
    "mail.subject.permission_granted": (
        "{{actor}} heeft je toegang tot {{page}} gegeven: {{access}}"
    ),
    "mail.subject.page_update": "{{actor}} heeft {{page}} gewijzigd",
    "mail.subject.digest": "Je overzicht: {{count}} paginawijzigingen",
    "mail.subject.comment_mention": "{{actor}} heeft je genoemd in een reactie",
    "mail.subject.comment_created": "{{actor}} heeft gereageerd op {{page}}",
    "mail.subject.comment_resolved": "{{actor}} heeft een reactie op {{page}} afgehandeld",
    "mail.subject.verification_expiring": "„{{page}}” moet opnieuw worden gecontroleerd",
    "mail.subject.verification_expired": "De controle van „{{page}}” is verlopen",
    "mail.subject.approval_requested": "„{{page}}” wacht op je goedkeuring",
    "mail.subject.approval_rejected": "„{{page}}” is teruggestuurd voor herziening",
    "mail.subject.password_changed": "Je wachtwoord is gewijzigd",
    "mail.subject.password_reset": "Stel je wachtwoord opnieuw in",
    "mail.subject.mfa_reset": "Tweefactorauthenticatie is opnieuw ingesteld",
    "mail.greeting": "Hallo",
    "mail.greeting_named": "Hallo {{name}}",
    "mail.footer": "Tessera · de kennisbank van je team",
    "mail.action.open_page": "Pagina openen",
    "mail.action.view_comment": "Reactie bekijken",
    "mail.action.review_page": "Pagina beoordelen",
    "mail.action.verify_page": "Pagina bevestigen",
    "mail.action.set_password": "Nieuw wachtwoord instellen",
    "mail.action.accept_invitation": "Uitnodiging accepteren",
    "mail.page_mention.body": "{{actor}} heeft je genoemd op {{page}}.",
    "mail.comment_created.body": "{{actor}} heeft gereageerd op {{page}}.",
    "mail.comment_mention.body": "{{actor}} heeft je genoemd in een reactie op {{page}}.",
    "mail.comment_resolved.body": "{{actor}} heeft een reactie op {{page}} afgehandeld.",
    "mail.permission_granted.body": "{{actor}} heeft je toegang tot {{page}} gegeven: {{access}}.",
    "mail.page_update.body": "{{actor}} heeft {{page}} in {{space}} gewijzigd.",
    "mail.digest.body": "Sinds het vorige overzicht zijn er {{count}} paginawijzigingen geweest.",
    "mail.digest.edited_by": "Bewerkt door {{names}}",
    "mail.approval_requested.body": (
        "{{actor}} heeft {{page}} in {{space}} ter goedkeuring ingediend."
    ),
    "mail.approval_rejected.body": (
        "{{actor}} heeft {{page}} in {{space}} teruggestuurd voor herziening."
    ),
    "mail.verification_expiring.body": (
        "De pagina {{page}} in {{space}} moet opnieuw worden gecontroleerd. De controle verloopt "
        "op {{date}}."
    ),
    "mail.verification_expired.body": (
        "De controle van {{page}} in {{space}} is verlopen. Bevestig de pagina opnieuw om te laten "
        "zien dat ze nog klopt."
    ),
    "mail.password_changed.body": "Je wachtwoord is gewijzigd.",
    "mail.password_changed.warning": (
        "Was jij dit niet, neem dan meteen contact op met de beheerder van de wiki."
    ),
    "mail.forgot_password.body": (
        "We hebben een verzoek ontvangen om je wachtwoord opnieuw in te stellen."
    ),
    "mail.forgot_password.note": (
        "De link is 30 minuten geldig. Heb je er niet om gevraagd, negeer dan deze e-mail."
    ),
    "mail.mfa_reset.body": (
        "Een beheerder heeft de tweefactorauthenticatie van je account{{scope}} opnieuw ingesteld. "
        "Een tweede factor is niet meer nodig om in te loggen."
    ),
    "mail.mfa_reset.next": "Stel tweefactorauthenticatie opnieuw in bij je profielinstellingen.",
    "mail.mfa_reset.warning": (
        "Heb je hier niet om gevraagd, neem dan meteen contact op met een beheerder."
    ),
    "mail.invitation.body": "Je bent uitgenodigd voor Tessera, de kennisbank van je team.",
    "mail.invitation.note": "Je krijgt deze e-mail omdat iemand uit het team je heeft uitgenodigd.",
    "mail.invitation_accepted.body": (
        "{{name}} ({{email}}) heeft je uitnodiging geaccepteerd en hoort nu bij de werkruimte."
    ),
}

PT = {
    "mail.access.writer": "edição",
    "mail.access.reader": "leitura",
    "mail.subject.invitation": "{{actor}} convidou você para o Tessera",
    "mail.subject.invitation_accepted": "{{name}} aceitou seu convite para o Tessera",
    "mail.subject.page_mention": "{{actor}} mencionou você em {{page}}",
    "mail.subject.permission_granted": "{{actor}} deu a você acesso de {{access}} a {{page}}",
    "mail.subject.page_update": "{{actor}} alterou {{page}}",
    "mail.subject.digest": "Seu resumo: {{count}} alterações de páginas",
    "mail.subject.comment_mention": "{{actor}} mencionou você em um comentário",
    "mail.subject.comment_created": "{{actor}} comentou em {{page}}",
    "mail.subject.comment_resolved": "{{actor}} resolveu um comentário em {{page}}",
    "mail.subject.verification_expiring": "«{{page}}» precisa ser verificada de novo",
    "mail.subject.verification_expired": "A verificação de «{{page}}» expirou",
    "mail.subject.approval_requested": "«{{page}}» aguarda sua aprovação",
    "mail.subject.approval_rejected": "«{{page}}» foi devolvida para revisão",
    "mail.subject.password_changed": "Sua senha foi alterada",
    "mail.subject.password_reset": "Redefina sua senha",
    "mail.subject.mfa_reset": "A autenticação em duas etapas foi redefinida",
    "mail.greeting": "Olá",
    "mail.greeting_named": "Olá, {{name}}",
    "mail.footer": "Tessera · a base de conhecimento da sua equipe",
    "mail.action.open_page": "Abrir página",
    "mail.action.view_comment": "Ver comentário",
    "mail.action.review_page": "Revisar página",
    "mail.action.verify_page": "Verificar página",
    "mail.action.set_password": "Definir uma nova senha",
    "mail.action.accept_invitation": "Aceitar convite",
    "mail.page_mention.body": "{{actor}} mencionou você em {{page}}.",
    "mail.comment_created.body": "{{actor}} comentou em {{page}}.",
    "mail.comment_mention.body": "{{actor}} mencionou você em um comentário em {{page}}.",
    "mail.comment_resolved.body": "{{actor}} resolveu um comentário em {{page}}.",
    "mail.permission_granted.body": "{{actor}} deu a você acesso de {{access}} a {{page}}.",
    "mail.page_update.body": "{{actor}} alterou {{page}} em {{space}}.",
    "mail.digest.body": "Houve {{count}} alterações de páginas desde o último resumo.",
    "mail.digest.edited_by": "Editada por {{names}}",
    "mail.approval_requested.body": "{{actor}} enviou {{page}} de {{space}} para sua aprovação.",
    "mail.approval_rejected.body": "{{actor}} devolveu {{page}} de {{space}} para revisão.",
    "mail.verification_expiring.body": (
        "A página {{page}} em {{space}} precisa ser verificada de novo. A verificação expira em "
        "{{date}}."
    ),
    "mail.verification_expired.body": (
        "A verificação de {{page}} em {{space}} expirou. Verifique a página de novo para confirmar "
        "que ela continua correta."
    ),
    "mail.password_changed.body": "Sua senha foi alterada.",
    "mail.password_changed.warning": (
        "Se não foi você, fale imediatamente com a administração do wiki."
    ),
    "mail.forgot_password.body": "Recebemos um pedido para redefinir sua senha.",
    "mail.forgot_password.note": (
        "O link vale por 30 minutos. Se você não pediu, ignore este e-mail."
    ),
    "mail.mfa_reset.body": (
        "A administração redefiniu a autenticação em duas etapas da sua conta{{scope}}. Um segundo "
        "fator não é mais necessário para entrar."
    ),
    "mail.mfa_reset.next": (
        "Configure a autenticação em duas etapas de novo nas configurações do seu perfil."
    ),
    "mail.mfa_reset.warning": "Se você não pediu isso, fale imediatamente com a administração.",
    "mail.invitation.body": (
        "Você foi convidado para o Tessera, a base de conhecimento da sua equipe."
    ),
    "mail.invitation.note": "Você recebeu este e-mail porque alguém da equipe convidou você.",
    "mail.invitation_accepted.body": (
        "{{name}} ({{email}}) aceitou seu convite e agora faz parte do espaço de trabalho."
    ),
}

ZH = {
    "mail.access.writer": "编辑",
    "mail.access.reader": "阅读",
    "mail.subject.invitation": "{{actor}} 邀请你加入 Tessera",
    "mail.subject.invitation_accepted": "{{name}} 已接受你的 Tessera 邀请",
    "mail.subject.page_mention": "{{actor}} 在 {{page}} 中提到了你",
    "mail.subject.permission_granted": "{{actor}} 授予你 {{page}} 的{{access}}权限",
    "mail.subject.page_update": "{{actor}} 修改了 {{page}}",
    "mail.subject.digest": "摘要：{{count}} 处页面变更",
    "mail.subject.comment_mention": "{{actor}} 在评论中提到了你",
    "mail.subject.comment_created": "{{actor}} 评论了 {{page}}",
    "mail.subject.comment_resolved": "{{actor}} 解决了 {{page}} 上的评论",
    "mail.subject.verification_expiring": "“{{page}}”需要重新核对",
    "mail.subject.verification_expired": "“{{page}}”的核对已过期",
    "mail.subject.approval_requested": "“{{page}}”正在等待你的批准",
    "mail.subject.approval_rejected": "“{{page}}”已被退回修改",
    "mail.subject.password_changed": "你的密码已更改",
    "mail.subject.password_reset": "重置密码",
    "mail.subject.mfa_reset": "两步验证已重置",
    "mail.greeting": "你好",
    "mail.greeting_named": "{{name}}，你好",
    "mail.footer": "Tessera · 团队的知识库",
    "mail.action.open_page": "打开页面",
    "mail.action.view_comment": "查看评论",
    "mail.action.review_page": "审阅页面",
    "mail.action.verify_page": "核对页面",
    "mail.action.set_password": "设置新密码",
    "mail.action.accept_invitation": "接受邀请",
    "mail.page_mention.body": "{{actor}} 在 {{page}} 中提到了你。",
    "mail.comment_created.body": "{{actor}} 评论了 {{page}}。",
    "mail.comment_mention.body": "{{actor}} 在 {{page}} 的评论中提到了你。",
    "mail.comment_resolved.body": "{{actor}} 解决了 {{page}} 上的评论。",
    "mail.permission_granted.body": "{{actor}} 授予你 {{page}} 的{{access}}权限。",
    "mail.page_update.body": "{{actor}} 修改了 {{space}} 中的 {{page}}。",
    "mail.digest.body": "自上次摘要以来，共有 {{count}} 处页面变更。",
    "mail.digest.edited_by": "编辑者：{{names}}",
    "mail.approval_requested.body": "{{actor}} 提交了 {{space}} 中的 {{page}} 供你批准。",
    "mail.approval_rejected.body": "{{actor}} 将 {{space}} 中的 {{page}} 退回修改。",
    "mail.verification_expiring.body": (
        "{{space}} 中的页面 {{page}} 需要重新核对。核对将于 {{date}} 过期。"
    ),
    "mail.verification_expired.body": (
        "{{space}} 中 {{page}} 的核对已过期。请重新核对页面，确认内容仍然正确。"
    ),
    "mail.password_changed.body": "你的密码已更改。",
    "mail.password_changed.warning": "如果这不是你本人操作，请立即联系维基管理员。",
    "mail.forgot_password.body": "我们收到了重置你密码的请求。",
    "mail.forgot_password.note": "链接 30 分钟内有效。如果不是你发起的，请忽略这封邮件。",
    "mail.mfa_reset.body": "管理员重置了你账户{{scope}}的两步验证。登录时不再需要第二重验证。",
    "mail.mfa_reset.next": "请在个人资料设置中重新启用两步验证。",
    "mail.mfa_reset.warning": "如果这不是你要求的，请立即联系管理员。",
    "mail.invitation.body": "你受邀加入 Tessera —— 团队的知识库。",
    "mail.invitation.note": "你收到这封邮件，是因为团队中有人邀请了你。",
    "mail.invitation_accepted.body": "{{name}}（{{email}}）已接受你的邀请，现在是工作区的一员。",
}

CATALOGUE = {
    "en-US": EN,
    "ru-RU": RU,
    "uk-UA": UK,
    "de-DE": DE,
    "es-ES": ES,
    "fr-FR": FR,
    "it-IT": IT,
    "ja-JP": JA,
    "ko-KR": KO,
    "nl-NL": NL,
    "pt-BR": PT,
    "zh-CN": ZH,
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
