/// <reference types="@sveltejs/kit" />

declare global {
  namespace App {
    interface Locals {
      /** Разобранный вход. Заполняется в `hooks.server.ts` на каждом запросе. */
      session: import('$lib/api/session').Session | null;
    }
    interface PageData {
      session?: import('$lib/api/session').Session | null;
    }
    interface Error {
      code?: string;
    }
  }
}

export {};
