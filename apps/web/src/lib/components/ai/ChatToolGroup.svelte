<script lang="ts">
  import { locale } from '$lib/stores/i18n.svelte';
  import { toolCalls, toolLabel, type ToolCall } from '$lib/features/ai/tools';

  type Props = {
    /** Вызовы реплики: сохранённые с сервера либо накопленные по ходу потока. */
    calls: unknown;
    /** Идёт ли ход прямо сейчас. У идущего последний шаг ещё без ответа. */
    streaming?: boolean;
  };
  const { calls, streaming = false }: Props = $props();

  const t = $derived(locale.t);
  const steps = $derived(toolCalls(calls));

  // Шаг без ответа — тот, что выполняется. Показывается вместо счётчика, чтобы
  // человек видел, чем занята модель, а не только что она занята.
  const running = $derived(
    streaming ? [...steps].reverse().find((one) => one.result === undefined) : undefined
  );

  let expanded = $state(false);
  let opened = $state<Record<string, boolean>>({});

  function toggle(key: string) {
    opened = { ...opened, [key]: !opened[key] };
  }

  function details(one: ToolCall): string {
    return JSON.stringify({ args: one.args, result: one.result }, null, 2);
  }
</script>

<!--
  Ход агента свёрнут в одну строку. Разворачивается по требованию: шагов бывает
  с десяток, и раскрытыми они заслоняют сам ответ. В v1 так же
  (`ee/ai-chat/components/chat-tool-group.tsx`).
-->
{#if steps.length > 0}
  <div data-component="ChatToolGroup" class="my-1.5 text-xs">
    <button
      type="button"
      class="inline-flex items-center gap-1.5 text-text-muted transition-colors hover:text-text"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      <span aria-hidden="true" class={running ? 'animate-spin' : ''}>
        {running ? '◌' : expanded ? '▾' : '▸'}
      </span>
      <span class="font-medium">
        {running ? `${toolLabel(running.name, t)}…` : `${t('Steps')} ${steps.length}`}
      </span>
    </button>

    {#if expanded}
      <div class="mt-1 flex flex-col gap-0.5 pl-3.5">
        {#each steps as step, index (step.id ?? index)}
          {@const key = String(step.id ?? index)}
          <div>
            <button
              type="button"
              class="inline-flex items-center gap-1 text-text-muted transition-colors hover:text-text"
              aria-expanded={opened[key] === true}
              onclick={() => toggle(key)}
            >
              <span aria-hidden="true" class="w-2 text-center opacity-60">·</span>
              <span aria-hidden="true">{opened[key] ? '▾' : '▸'}</span>
              <span>{toolLabel(step.name, t)}</span>
            </button>
            {#if opened[key]}
              <pre
                class="ml-4 mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-surface-hover px-2.5 py-1.5 text-[11px] leading-relaxed text-text-muted">{details(
                  step
                )}</pre>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
