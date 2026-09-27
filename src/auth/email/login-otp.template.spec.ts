import { loginOtpTemplate } from './login-otp.template';

describe('loginOtpTemplate', () => {
  const code = '012345';
  const { subject, html } = loginOtpTemplate(code);

  it('preserves the return contract and a code-free subject', () => {
    expect(Object.keys(loginOtpTemplate(code)).sort()).toEqual([
      'html',
      'subject',
    ]);
    expect(subject).toBe('Tu código de acceso a Houndfe');
    expect(subject).not.toContain(code);
  });

  it('keeps leading zeros in one continuous, copyable code element', () => {
    expect(html.match(/<strong\b[^>]*>([0-9]{6})<\/strong>/g)).toHaveLength(1);
    expect(html).toMatch(/<strong\b[^>]*>012345<\/strong>/);
    expect(html.split(code)).toHaveLength(2);
    expect(html).not.toMatch(/preheader|display:\s*none|visibility:\s*hidden/i);
  });

  it('provides a Spanish document with mobile viewport metadata', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/<html lang="es">/);
    expect(html).toMatch(/<meta charset="utf-8"\s*\/?>/i);
    expect(html).toMatch(
      /<meta name="viewport" content="width=device-width, initial-scale=1"\s*\/?>/,
    );
    expect(html).toMatch(/<body\b[^>]*>[\s\S]*<\/body>\s*<\/html>$/);
  });

  it('uses fluid presentation tables and inline visual hierarchy', () => {
    const tables = html.match(/<table\b[^>]*>/g) ?? [];
    expect(tables.length).toBeGreaterThanOrEqual(2);
    for (const table of tables) {
      expect(table).toContain('role="presentation"');
      expect(table).toContain('width="100%"');
      expect(table).toContain('style="');
    }
    expect(html).toMatch(/max-width:\s*600px/);
    expect(html).toMatch(/<h1 style="[^"]+">Tu código de acceso es:<\/h1>/);
    expect(html).toMatch(
      /<td[^>]*style="[^"]*font-family:[^"]*Courier[^"]*">\s*<strong>012345<\/strong>/,
    );
    expect(html).toMatch(/letter-spacing:\s*[1-9][0-9]*px/);
    expect(html).toContain('Trebuchet MS');
    expect(html).not.toMatch(/display:\s*(flex|grid)/i);
  });

  it('preserves exact copy and readable order when markup is stripped', () => {
    const text = html
      .replace(/<head>[\s\S]*?<\/head>/, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    expect(text).toBe(
      'Houndfe Tu código de acceso es: 012345 Vence en 10 minutos. No lo compartas con nadie. Si no solicitaste este código, ignora este correo.',
    );
  });

  it('contains only passive, self-contained email markup', () => {
    const tags = Array.from(html.matchAll(/<([a-z][a-z0-9]*)\b/gi), (match) =>
      match[1].toLowerCase(),
    );
    const allowed = [
      'html',
      'head',
      'meta',
      'body',
      'table',
      'tbody',
      'tr',
      'td',
      'p',
      'h1',
      'strong',
    ];
    expect(tags.every((tag) => allowed.includes(tag))).toBe(true);
    expect(html).not.toMatch(
      /\b(?:src|href|action|on[a-z]+)\s*=|url\s*\(|@import|https?:|javascript:|data:/i,
    );
  });

  it.each([
    '<script>',
    '12345',
    '１２３４５６',
    '',
    '1234567',
    '01234a',
    ' 012345',
    '012345\n',
  ])('rejects non-generated input %s', (input) =>
    expect(() => loginOtpTemplate(input)).toThrow('Invalid login code format'),
  );
});
