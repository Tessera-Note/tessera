import { zod4Resolver } from "mantine-form-zod-resolver";
import i18n from "@/i18n";

/**
 * Сообщения проверки формы на языке читающего.
 *
 * Схемы zod объявляются на уровне модуля, где хук `useTranslation` вызвать
 * нельзя, поэтому сообщения в них оставались английскими строками: человек с
 * любой из двенадцати локалей видел под полем английский текст, и ни одна
 * проверка на это не жаловалась.
 *
 * Переводить схему негде, но перевести можно результат. Резолвер отдает готовые
 * сообщения по полям, и здесь каждое проходит через словарь. Ключом служит сама
 * английская фраза, как и везде в этом проекте, поэтому в схеме ничего менять
 * не надо.
 *
 * Незаведенное сообщение возвращается как есть. Так ведут себя и встроенные
 * тексты zod («Too small: expected string...»), которые в словаре не заводятся:
 * их формулировки задает библиотека и меняются они вместе с ней.
 */
export function i18nZodResolver(schema: Parameters<typeof zod4Resolver>[0]) {
  const resolve = zod4Resolver(schema);

  // Тип резолвера сохраняется дословно: формы выводят из него типы значений и
  // обработчика отправки, и подмена его на общий словарь ломала бы вывод.
  const translating: typeof resolve = (values) => {
    const errors = resolve(values);

    for (const [field, message] of Object.entries(errors)) {
      if (typeof message === "string") {
        errors[field] = i18n.t(message, { defaultValue: message });
      }
    }

    return errors;
  };

  return translating;
}
