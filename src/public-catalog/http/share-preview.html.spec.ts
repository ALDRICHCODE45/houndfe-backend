/**
 * Public catalog v0 (S6) — the share-preview HTML. Every dynamic value is
 * escaped for its context, and no price ever appears.
 */
import {
  renderMissRedirectHtml,
  renderSharePreviewHtml,
} from './share-preview.html';

const base = {
  siteName: 'Sucursal Centro',
  title: 'Croquetas Indoor 1.5 kg',
  description: 'Croquetas horneadas para interiores.',
  image: 'https://cdn.example.com/p.jpg',
  url: 'https://sistem.houndfe.com/catalogo/centro/p/abc',
};

describe('renderSharePreviewHtml', () => {
  it('emits the og/twitter tags, the refresh and the script redirect', () => {
    const html = renderSharePreviewHtml(base);
    expect(html).toContain(
      '<meta property="og:title" content="Croquetas Indoor 1.5 kg">',
    );
    expect(html).toContain(
      '<meta property="og:description" content="Croquetas horneadas para interiores.">',
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://cdn.example.com/p.jpg">',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://sistem.houndfe.com/catalogo/centro/p/abc">',
    );
    expect(html).toContain('<meta property="og:type" content="product">');
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image">',
    );
    expect(html).toContain(
      '<meta http-equiv="refresh" content="0;url=https://sistem.houndfe.com/catalogo/centro/p/abc">',
    );
    expect(html).toContain(
      'location.replace("https://sistem.houndfe.com/catalogo/centro/p/abc")',
    );
    expect(html).toContain(
      '<a href="https://sistem.houndfe.com/catalogo/centro/p/abc">',
    );
  });

  it('falls back to a summary card and omits og:image when there is no image', () => {
    const html = renderSharePreviewHtml({ ...base, image: null });
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('twitter:image');
  });

  it('never prints a price', () => {
    const html = renderSharePreviewHtml(base);
    expect(html).not.toMatch(/price|precio|\$\s?\d|product:amount/i);
  });

  it('escapes a product name that tries to break out of the attribute', () => {
    const html = renderSharePreviewHtml({
      ...base,
      title: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain(
      'content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"',
    );
    // The only script left is the redirect.
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it.each([
    ['description', { description: `x" onload="alert(1)` }],
    ['site name', { siteName: `'><img src=x onerror=alert(1)>` }],
    ['image', { image: 'https://x.test/a.jpg"><script>alert(2)</script>' }],
  ])('escapes the %s', (_label, override) => {
    const html = renderSharePreviewHtml({ ...base, ...override });
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toMatch(/content="[^"]*"\s+onload=/);
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it('escapes the redirect URL in the attribute, the anchor and the script', () => {
    const url = 'https://s.test/catalogo/c/p/1?priceListId=a"b</script><b>&x';
    const html = renderSharePreviewHtml({ ...base, url });
    expect(html).toContain('&quot;');
    expect(html).not.toContain('</script><b>');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('collapses whitespace and cuts a long description', () => {
    const html = renderSharePreviewHtml({
      ...base,
      description: `${'palabra '.repeat(80)}\n\n fin`,
    });
    const [, text] = /og:description" content="([^"]*)"/.exec(html) ?? [];
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).not.toContain('\n');
    expect(text.endsWith('…')).toBe(true);
  });

  it('uses the site name when the description is empty', () => {
    const html = renderSharePreviewHtml({ ...base, description: null });
    expect(html).toContain('og:description" content="Sucursal Centro"');
  });
});

describe('renderMissRedirectHtml', () => {
  it('redirects to the store home without any og tag', () => {
    const html = renderMissRedirectHtml('https://sistem.houndfe.com/catalogo');
    expect(html).toContain(
      '<meta http-equiv="refresh" content="0;url=https://sistem.houndfe.com/catalogo">',
    );
    expect(html).toContain(
      'location.replace("https://sistem.houndfe.com/catalogo")',
    );
    expect(html).not.toContain('og:');
  });
});
