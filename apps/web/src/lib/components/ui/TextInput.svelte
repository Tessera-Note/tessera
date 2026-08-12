<script lang="ts">
  type Props = {
    value: string;
    type?: 'text' | 'email' | 'password' | 'search';
    /** Тип берётся у самого атрибута: строкой сюда пролезает опечатка. */
    autocomplete?: AutoFill;
    placeholder?: string;
    required?: boolean;
    disabled?: boolean;
  };
  let {
    value = $bindable(),
    type = 'text',
    autocomplete,
    placeholder,
    required = false,
    disabled = false
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
    class="w-full rounded border border-border bg-surface px-3 py-2 disabled:opacity-60"
    type="password"
    {autocomplete}
    {placeholder}
    {required}
    {disabled}
    bind:value
  />
{:else if type === 'email'}
  <input
    data-component="TextInput"
    class="w-full rounded border border-border bg-surface px-3 py-2 disabled:opacity-60"
    type="email"
    {autocomplete}
    {placeholder}
    {required}
    {disabled}
    bind:value
  />
{:else if type === 'search'}
  <input
    data-component="TextInput"
    class="w-full rounded border border-border bg-surface px-3 py-2 disabled:opacity-60"
    type="search"
    {autocomplete}
    {placeholder}
    {required}
    {disabled}
    bind:value
  />
{:else}
  <input
    data-component="TextInput"
    class="w-full rounded border border-border bg-surface px-3 py-2 disabled:opacity-60"
    type="text"
    {autocomplete}
    {placeholder}
    {required}
    {disabled}
    bind:value
  />
{/if}
