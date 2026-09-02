<script lang="ts">
  type Props = {
    value: string;
    type?: 'text' | 'email' | 'password' | 'search';
    /** Тип берётся у самого атрибута: строкой сюда пролезает опечатка. */
    autocomplete?: AutoFill;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
    /** Идентификатор перечня подсказок. Подсказка, а не выбор: значение
     *  остаётся вводимым, а перечень лишь помогает не набирать его руками. */
    list?: string;
  };
  let {
    value = $bindable(),
    type = 'text',
    autocomplete,
    placeholder,
    required = false,
    disabled = false,
    list
  }: Props = $props();
</script>

<!--
  Вид поля задаётся атрибутом, а не отдельным компонентом на каждый вид: у
  Svelte связывание значения с `type` в переменной требует ветвления, и одна
  ветка на вид дешевле пяти компонентов с одинаковой разметкой.
-->
{#if type === 'password'}
  <input
    data-component="TextInput"
    class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:opacity-70"
    type="password"
    {autocomplete}
    {placeholder}
    {required}
    {disabled}
    {list}
    bind:value
  />
{:else if type === 'email'}
  <input
    data-component="TextInput"
    class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:opacity-70"
    type="email"
    {autocomplete}
    {placeholder}
    {required}
    {disabled}
    {list}
    bind:value
  />
{:else if type === 'search'}
  <input
    data-component="TextInput"
    class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:opacity-70"
    type="search"
    {autocomplete}
    {placeholder}
    {required}
    {disabled}
    {list}
    bind:value
  />
{:else}
  <input
    data-component="TextInput"
    class="h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft disabled:opacity-70"
    type="text"
    {autocomplete}
    {placeholder}
    {required}
    {disabled}
    {list}
    bind:value
  />
{/if}
