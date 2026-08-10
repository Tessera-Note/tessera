import { KyselyDB, KyselyTransaction } from './types/kysely.types';

/*
 * Executes a transaction or a callback using the provided database instance.
 * If an existing transaction is provided, it directly executes the callback with it.
 * Otherwise, it starts a new transaction using the provided database instance and executes the callback within that transaction.
 */
export async function executeTx<T>(
  db: KyselyDB,
  callback: (trx: KyselyTransaction) => Promise<T>,
  existingTrx?: KyselyTransaction,
): Promise<T> {
  if (existingTrx) {
    return await callback(existingTrx); // Execute callback with existing transaction
  } else {
    return await db.transaction().execute((trx) => callback(trx)); // Start new transaction and execute callback
  }
}

/*
 * This function returns either an existing transaction if provided,
 * or the normal database instance.
 */
export function dbOrTx(
  db: KyselyDB,
  existingTrx?: KyselyTransaction,
): KyselyDB | KyselyTransaction {
  if (existingTrx) {
    return existingTrx; // Use existing transaction
  } else {
    return db; // Use normal database instance
  }
}

/**
 * Конфигурация текстового поиска для всех векторов и запросов.
 *
 * Заведена миграцией `20260810T210000` копией стоковой `russian`. Та
 * двуязычна по устройству: латиницу отдает `english_stem`, кириллицу
 * `russian_stem`. Держать имя в одном месте важно потому, что вектор и запрос
 * обязаны разбираться одинаково: разойдясь, они перестанут совпадать молча.
 */
export const SEARCH_CONFIG = 'tessera_search';
