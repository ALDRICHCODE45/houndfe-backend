/**
 * Public catalog v0 (S6) — minimal HTML for link previews. Crawlers read the
 * Open Graph tags; browsers follow the meta refresh (or the script) to the
 * storefront. Every dynamic value is escaped for the context it lands in, and
 * the page never carries a price.
 */

export interface SharePreviewInput {
  siteName: string;
  title: string;
  description: string | null;
  image: string | null;
  /** The storefront URL the page redirects to (also `og:url`). */
  url: string;
}

const DESCRIPTION_MAX = 200;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text and attribute context. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** A JavaScript string literal safe inside an inline `<script>`. */
function scriptString(value: string): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function summarize(description: string | null, fallback: string): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return fallback;
  return text.length <= DESCRIPTION_MAX
    ? text
    : `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
}

function redirectBlock(url: string): string {
  return [
    `<meta http-equiv="refresh" content="0;url=${escapeHtml(url)}">`,
    `<script>location.replace(${scriptString(url)})</script>`,
  ].join('\n');
}

export function renderSharePreviewHtml(input: SharePreviewInput): string {
  const title = escapeHtml(input.title);
  const description = escapeHtml(summarize(input.description, input.siteName));
  const url = escapeHtml(input.url);
  const image = input.image === null ? null : escapeHtml(input.image);
  const meta = [
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="${escapeHtml(input.siteName)}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    ...(image ? [`<meta property="og:image" content="${image}">`] : []),
    `<meta property="og:url" content="${url}">`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    ...(image ? [`<meta name="twitter:image" content="${image}">`] : []),
  ];
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${title}</title>
${meta.join('\n')}
${redirectBlock(input.url)}
</head>
<body>
<p><a href="${url}">${title}</a></p>
</body>
</html>
`;
}

/** Unknown tenant or product: no preview, just back to the storefront home. */
export function renderMissRedirectHtml(homeUrl: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Catálogo</title>
<meta name="robots" content="noindex">
${redirectBlock(homeUrl)}
</head>
<body>
<p><a href="${escapeHtml(homeUrl)}">Ir al catálogo</a></p>
</body>
</html>
`;
}
