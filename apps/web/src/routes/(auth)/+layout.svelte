<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = { children: Snippet };
  const { children }: Props = $props();
</script>

<!--
  Расстановка v1 (`features/auth/components/auth-layout.tsx` и `auth.module.css`):
  название продукта со значком, отступ сверху 80 точек, карточка ниже на 40.
  Блок стоит от верха, а не по середине экрана: на длинной форме заведения
  рабочего пространства середина уводит начало формы под край.

  Название здесь, а не в каждой форме: экранов входа семь, и семь его копий
  разошлись бы на первой же правке.
-->
<div data-section="auth" class="min-h-screen bg-surface-muted px-4 pb-12">
  <div class="mx-auto w-full max-w-[420px]">
    <div class="flex items-center justify-center gap-2 pt-[80px] sm:pt-[80px]">
      <img src="/favicon.svg" alt="Tessera" width="22" height="22" />
      <span class="select-none text-[28px] font-bold leading-none">Tessera</span>
    </div>

    <main class="mt-10">
      {@render children()}
    </main>
  </div>
</div>
