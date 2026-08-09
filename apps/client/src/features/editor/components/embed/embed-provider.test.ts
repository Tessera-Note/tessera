import { describe, expect, it } from "vitest";
import { getEmbedUrlAndProvider } from "@tessera/editor-ext";

/**
 * Таблицы на `docs.google.com` распознавались, а документы и презентации нет:
 * их ссылка проваливалась в общий iframe, и встраивался адрес редактора со
 * всеми параметрами.
 */
describe("getEmbedUrlAndProvider, документы Google", () => {
  const DOC =
    "https://docs.google.com/document/d/1qv3kPmd_5gz29WjgYDpS-pEnslZ8Z0GqqseY2Lecuj4/edit?pli=1&tab=t.0#heading=h.4hwz0jqmgj43";

  it("ссылка на документ распознается как Google Docs, а не как iframe", () => {
    expect(getEmbedUrlAndProvider(DOC).provider).toBe("google docs");
  });

  it("встраивается адрес просмотра, а не редактора", () => {
    expect(getEmbedUrlAndProvider(DOC).embedUrl).toBe(
      "https://docs.google.com/document/d/1qv3kPmd_5gz29WjgYDpS-pEnslZ8Z0GqqseY2Lecuj4/preview",
    );
  });

  // Параметры запроса и якорь относятся к интерфейсу редактора.
  it("параметры и якорь отбрасываются", () => {
    const { embedUrl } = getEmbedUrlAndProvider(DOC);

    expect(embedUrl).not.toContain("pli=1");
    expect(embedUrl).not.toContain("#heading");
  });

  it("ссылка без хвоста тоже распознается", () => {
    const { provider, embedUrl } = getEmbedUrlAndProvider(
      "https://docs.google.com/document/d/ABC_123-xyz",
    );

    expect(provider).toBe("google docs");
    expect(embedUrl).toBe(
      "https://docs.google.com/document/d/ABC_123-xyz/preview",
    );
  });

  it("презентация получает свою встраиваемую форму", () => {
    const { provider, embedUrl } = getEmbedUrlAndProvider(
      "https://docs.google.com/presentation/d/DECK123/edit#slide=id.p1",
    );

    expect(provider).toBe("google slides");
    expect(embedUrl).toBe(
      "https://docs.google.com/presentation/d/DECK123/embed",
    );
  });

  it("форма приводится к виду для заполнения", () => {
    const { provider, embedUrl } = getEmbedUrlAndProvider(
      "https://docs.google.com/forms/d/e/FORM123/edit",
    );

    expect(provider).toBe("google forms");
    expect(embedUrl).toContain("/viewform");
  });

  /**
   * Таблица отдавалась как есть, то есть встраивался адрес редактора со всеми
   * его параметрами. Приведена к той же форме, что документ и презентация.
   */
  it("таблица приводится к форме просмотра", () => {
    const { provider, embedUrl } = getEmbedUrlAndProvider(
      "https://docs.google.com/spreadsheets/d/SHEET1/edit?usp=drivesdk&ouid=9",
    );

    expect(provider).toBe("google sheets");
    expect(embedUrl).toBe(
      "https://docs.google.com/spreadsheets/d/SHEET1/preview",
    );
  });

  // В адресе редактора номер листа выбирает вкладку: без него встроенная
  // таблица открылась бы не на той, что дал человек.
  it("номер листа переносится", () => {
    const { embedUrl } = getEmbedUrlAndProvider(
      "https://docs.google.com/spreadsheets/d/SHEET1/edit#gid=1234567",
    );

    expect(embedUrl).toBe(
      "https://docs.google.com/spreadsheets/d/SHEET1/preview#gid=1234567",
    );
  });

  /**
   * У опубликованной таблицы вместо идентификатора отдельный маркер, и это
   * уже готовая для встраивания форма: приводить ее к просмотру нечем.
   */
  it("опубликованная таблица отдается как есть", () => {
    const url =
      "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml?gid=5&single=true";
    const { provider, embedUrl } = getEmbedUrlAndProvider(url);

    expect(provider).toBe("google sheets");
    expect(embedUrl).toBe(url);
  });

  it("файл Drive не перехватывается новыми правилами", () => {
    const { provider, embedUrl } = getEmbedUrlAndProvider(
      "https://drive.google.com/file/d/FILE1/view",
    );

    expect(provider).toBe("google drive");
    expect(embedUrl).toBe("https://drive.google.com/file/d/FILE1/preview");
  });

  /**
   * Drive распознавался только по ссылке на файл: папка и старая форма
   * `open?id=` проваливались в общий iframe, где Drive показывает отказ.
   */
  it.each([
    "https://drive.google.com/drive/folders/FOLDER1",
    "https://drive.google.com/drive/u/0/folders/FOLDER1",
  ])("папка %s получает свою встраиваемую форму", (url) => {
    const { provider, embedUrl } = getEmbedUrlAndProvider(url);

    expect(provider).toBe("google drive");
    expect(embedUrl).toBe(
      "https://drive.google.com/embeddedfolderview?id=FOLDER1",
    );
  });

  it("старая форма ссылки на файл приводится к просмотру", () => {
    const { provider, embedUrl } = getEmbedUrlAndProvider(
      "https://drive.google.com/open?id=FILE2",
    );

    expect(provider).toBe("google drive");
    expect(embedUrl).toBe("https://drive.google.com/file/d/FILE2/preview");
  });

  it("посторонний адрес по-прежнему идет через iframe", () => {
    expect(getEmbedUrlAndProvider("https://example.com/page").provider).toBe(
      "iframe",
    );
  });
});
