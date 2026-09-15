/**
 * Обращения к серверной половине.
 *
 * Здесь нет ни одного решения о правах и ни одной записи в базу: и то и другое
 * описано на стороне Python и второго описания иметь не должно. Этот файл
 * только спрашивает и передаёт ответ дальше.
 *
 * Секрет уходит своим заголовком, а не `Authorization`: в том ходят токены
 * людей, и путать два разных вида предъявления себя нельзя даже по имени.
 */

/**
 * Окружение читается на каждом вызове, а не при загрузке файла.
 *
 * Значение, снятое при загрузке, привязывает адрес к порядку импортов: файл,
 * подключённый раньше, чем выставлено окружение, навсегда запоминает адрес по
 * умолчанию. В проверках это выглядит как зависший запрос к несуществующему
 * узлу, а в развёртывании — как обращение не туда после смены переменной.
 */
function settings() {
  return {
    apiUrl: (process.env.API_URL || 'http://tessera-v2-api:3000').replace(/\/+$/, ''),
    token: process.env.COLLAB_INTERNAL_TOKEN || '',
    // Сколько ждать ответа. Обращения короткие: один запрос к базе.
    timeoutMs: Number(process.env.COLLAB_BACKEND_TIMEOUT_MS || 10000),
  };
}

/**
 * Отказ серверной половины с сохранённым кодом.
 *
 * Код нужен вызывающему: «нет доступа» закрывает соединение молча, а
 * недоступная база это временный отказ, после которого клиент переподключается.
 */
export class BackendError extends Error {
  constructor(status, code, message, params) {
    super(message || code || `HTTP ${status}`);
    this.name = 'BackendError';
    this.status = status;
    this.code = code;
    // Подробности отказа: для занятого документа — какая реплика его держит.
    this.params = params || {};
  }
}

async function call(path, payload) {
  const { apiUrl, token: internalToken, timeoutMs } = settings();

  if (!internalToken) {
    // Без секрета внутренние маршруты выключены на той стороне. Отказ здесь,
    // а не там: иначе каждое подключение стоит запроса по сети ради того же
    // ответа.
    throw new BackendError(0, 'collab.internal_token_missing', 'COLLAB_INTERNAL_TOKEN не задан');
  }

  if (!/^[\x21-\x7e]+$/.test(internalToken)) {
    // Заголовок HTTP допускает только видимые знаки латиницы. Секрет с
    // кириллицей или пробелом роняет сам вызов, и отказ приходит из недр
    // клиента сообщением про ByteString, по которому причину не найти.
    throw new BackendError(
      0,
      'collab.internal_token_invalid',
      'COLLAB_INTERNAL_TOKEN обязан состоять из видимых знаков латиницы',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': internalToken,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    throw new BackendError(0, 'collab.backend_unreachable', String(error?.message || error));
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Тело не разобралось: для отказа это не важно, а для успеха означает, что
    // на том конце не наш маршрут.
    body = null;
  }

  if (!response.ok) {
    throw new BackendError(response.status, body?.code, body?.message, body?.params);
  }
  return body;
}

export function authorize(token, documentName) {
  return call('/api/internal/collab/authorize', { token, documentName });
}

export function loadDocument(pageId) {
  return call('/api/internal/collab/document', { pageId });
}

export function storeDocument(payload) {
  return call('/api/internal/collab/store', payload);
}

export function rights(documentName, userIds) {
  return call('/api/internal/collab/rights', { documentName, userIds });
}

/**
 * Отметка владения документом. Решает приложение: срок жизни и период
 * продления живут в его настройках, а Redis — на его стороне.
 */
export function claimDocument(documentName, replica) {
  return call('/api/internal/collab/owner', { documentName, replica });
}

export function renewDocuments(documents, replica) {
  return call('/api/internal/collab/owner/renew', { documents, replica });
}

export function releaseDocument(documentName, replica) {
  return call('/api/internal/collab/owner/release', { documentName, replica });
}
