export interface IEmbedProvider {
  id: string;
  name: string;
  regex: RegExp;
  getEmbedUrl: (match: RegExpMatchArray, url?: string) => string;
}

export const embedProviders: IEmbedProvider[] = [
  {
    id: "loom",
    name: "Loom",
    regex: /^https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([\da-zA-Z]+)\/?/,
    getEmbedUrl: (match, url) => {
      if (url.includes("/embed/")) {
        return url;
      }
      return `https://loom.com/embed/${match[1]}`;
    },
  },
  {
    id: "airtable",
    name: "Airtable",
    regex: /^https:\/\/(www.)?airtable.com\/([a-zA-Z0-9]{2,})\/.*/,
    getEmbedUrl: (match, url: string) => {
      const path = url.split("airtable.com/");
      if (url.includes("/embed/")) {
        return url;
      }
      return `https://airtable.com/embed/${path[1]}`;
    },
  },
  {
    id: "figma",
    name: "Figma",
    regex:
      /^https:\/\/[\w\.-]+\.?figma.com\/(file|proto|board|design|slides|deck)\/([0-9a-zA-Z]{22,128})/,
    getEmbedUrl: (match, url: string) => {
      return `https://www.figma.com/embed?url=${url}&embed_host=tessera`;
    },
  },
  {
    id: "typeform",
    name: "Typeform",
    regex: /^(https?:)?(\/\/)?[\w\.]+\.typeform\.com\/to\/.+/,
    getEmbedUrl: (match, url: string) => {
      return url;
    },
  },
  {
    id: "miro",
    name: "Miro",
    regex: /^https:\/\/(www\.)?miro\.com\/app\/board\/([\w-]+=)/,
    getEmbedUrl: (match, url) => {
      if (url.includes("/live-embed/")) {
        return url;
      }
      return `https://miro.com/app/live-embed/${match[2]}?embedMode=view_only_without_ui&autoplay=true&embedSource=tessera`;
    },
  },
  {
    id: "youtube",
    name: "YouTube",
    regex:
      /^((?:https?:)?\/\/)?((?:www|m|music)\.)?((?:youtube\.com|youtu.be))(\/(?:[\w\-]+\?v=|embed\/|v\/)?)([\w\-]+)(\S+)?$/,
    getEmbedUrl: (match, url) => {
      if (url.includes("/embed/")) {
        return url;
      }
      return `https://www.youtube-nocookie.com/embed/${match[5]}`;
    },
  },
  {
    id: "vimeo",
    name: "Vimeo",
    regex:
      /^(https:)?\/\/(?:www\.|player\.)?vimeo.com\/(?:channels\/(?:\w+\/)?|groups\/([^/]*)\/videos\/|album\/(\d+)\/video\/|video\/|)(\d+)/,
    getEmbedUrl: (match) => {
      return `https://player.vimeo.com/video/${match[4]}`;
    },
  },
  {
    id: "framer",
    name: "Framer",
    regex: /^https:\/\/(www\.)?framer\.com\/embed\/([\w-]+)/,
    getEmbedUrl: (match, url: string) => {
      return url;
    },
  },
  {
    // Drive распознавался только по ссылке на файл. Ссылка на папку и старая
    // форма `open?id=` проваливались в общий iframe, где Drive показывает
    // отказ. Все три вида ведут к одному сервису, поэтому обрабатываются
    // одним провайдером: человек не обязан знать, какой из них у него в
    // буфере обмена.
    id: "gdrive",
    name: "Google Drive",
    regex:
      /^((?:https?:)?\/\/)?((?:www|m)\.)?drive\.google\.com\/(?:file\/d\/([a-zA-Z0-9_-]+)|drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)|open\?id=([a-zA-Z0-9_-]+))/,
    getEmbedUrl: (match) => {
      const fileId = match[3] ?? match[5];
      if (fileId) {
        return `https://drive.google.com/file/d/${fileId}/preview`;
      }
      // Своя встраиваемая форма: обычный адрес папки Drive во фрейме не
      // открывается.
      return `https://drive.google.com/embeddedfolderview?id=${match[4]}`;
    },
  },
  {
    id: "gsheets",
    name: "Google Sheets",
    regex:
      /^((?:https?:)?\/\/)?((?:www|m)\.)?(docs\.google\.com)\/spreadsheets\/d\/([a-zA-Z0-9_-]+)\/.*$/,
    getEmbedUrl: (match, url: string) => {
      return url;
    },
  },
  {
    // Таблицы на docs.google.com распознавались, а документы и презентации
    // нет: их ссылка проваливалась в общий iframe и встраивался адрес
    // редактора со всеми параметрами вида `?pli=1&tab=t.0#heading=...`.
    // Встраиваемая форма у документа это `/preview`, как и у файла Drive.
    id: "gdocs",
    name: "Google Docs",
    regex:
      /^((?:https?:)?\/\/)?((?:www|m)\.)?(docs\.google\.com)\/document\/d\/([a-zA-Z0-9_-]+)(\/.*)?$/,
    getEmbedUrl: (match) => {
      return `https://docs.google.com/document/d/${match[4]}/preview`;
    },
  },
  {
    id: "gslides",
    name: "Google Slides",
    regex:
      /^((?:https?:)?\/\/)?((?:www|m)\.)?(docs\.google\.com)\/presentation\/d\/([a-zA-Z0-9_-]+)(\/.*)?$/,
    getEmbedUrl: (match) => {
      return `https://docs.google.com/presentation/d/${match[4]}/embed`;
    },
  },
  {
    // Форма без `/viewform` открывается на редактирование и во фрейме
    // показывает отказ.
    id: "gforms",
    name: "Google Forms",
    regex:
      /^((?:https?:)?\/\/)?((?:www|m)\.)?(docs\.google\.com)\/forms\/d\/(?:e\/)?([a-zA-Z0-9_-]+)(\/.*)?$/,
    getEmbedUrl: (match, url: string) => {
      return url.includes("/viewform")
        ? url
        : `https://docs.google.com/forms/d/e/${match[4]}/viewform?embedded=true`;
    },
  },
  {
    id: "iframe",
    name: "Iframe",
    regex: /any-iframe/,
    getEmbedUrl: (match, url) => {
      return url;
    },
  },
];

export function getEmbedProviderById(id: string) {
  return embedProviders.find(
    (provider) => provider.id.toLowerCase() === id.toLowerCase(),
  );
}

export interface IEmbedResult {
  embedUrl: string;
  provider: string;
}

export function getEmbedUrlAndProvider(url: string): IEmbedResult {
  for (const provider of embedProviders) {
    const match = url.match(provider.regex);
    if (match) {
      return {
        embedUrl: provider.getEmbedUrl(match, url),
        provider: provider.name.toLowerCase(),
      };
    }
  }
  return {
    embedUrl: url,
    provider: "iframe",
  };
}
