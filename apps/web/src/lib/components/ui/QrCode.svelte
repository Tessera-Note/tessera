<script lang="ts">
  import qrcode from 'qrcode-generator';

  type Props = {
    /** Что закодировать. Для второго фактора это ссылка `otpauth://…`. */
    value: string;
    /** Подпись для тех, кто картинку не видит. */
    label: string;
    size?: number;
  };
  const { value, label, size = 176 }: Props = $props();

  /**
   * Код рисуется как SVG, а не картинкой с сервера.
   *
   * Сервер v2 на Python, и рисование там означало бы вторую библиотеку в другом
   * языке ради того же изображения. SVG к тому же не мылится при увеличении и
   * не требует размера в пикселях заранее.
   *
   * Уровень коррекции `M` и автоподбор версии — как в v1: ссылка второго
   * фактора длиннее сотни знаков, и фиксированная версия обрезала бы её.
   */
  const svg = $derived.by(() => {
    if (!value) return '';
    const code = qrcode(0, 'M');
    code.addData(value);
    code.make();
    return code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  });
</script>

<div
  data-component="QrCode"
  class="inline-block rounded bg-white p-2"
  style="width: {size}px"
  role="img"
  aria-label={label}
>
  <!--
    Разметка приходит из библиотеки, а не из данных: внутрь идёт только ссылка,
    которую библиотека кодирует в прямоугольники. Своего текста в выводе нет.
  -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html svg}
</div>
