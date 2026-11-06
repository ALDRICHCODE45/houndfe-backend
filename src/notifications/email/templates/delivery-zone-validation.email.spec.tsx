/**
 * shipping-zones / T1 (S3) — staff email for a new delivery-zone validation.
 * Pins the Spanish subject, the postal-code details and the 24 h deadline
 * copy; no customer phone or conversation reference is ever rendered.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import {
  composeDeliveryZoneValidationSubject,
  DeliveryZoneValidationEmail,
} from './delivery-zone-validation.email';

const PROPS = {
  branchName: 'Sucursal Centro',
  zipCode: '06700',
  state: 'Ciudad de México',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
  deadlineAt: '2026-11-06T16:00:00.000Z',
  appBaseUrl: 'https://app.houndfe.test',
};

describe('DeliveryZoneValidationEmail', () => {
  it('uses a Spanish subject with the postal code', () => {
    expect(composeDeliveryZoneValidationSubject('06700')).toBe(
      'Validar zona de entrega: CP 06700',
    );
  });

  it('renders the postal code, the place and the 24 h deadline in Spanish', () => {
    const html = renderToStaticMarkup(DeliveryZoneValidationEmail(PROPS));
    expect(html).toContain('Validar zona de entrega: CP 06700');
    expect(html).toContain('06700');
    expect(html).toContain('Roma Norte');
    expect(html).toContain('Cuauhtémoc');
    expect(html).toContain('Sucursal Centro');
    expect(html).toContain('24 horas');
    // es-MX, America/Mexico_City: 2026-11-06 16:00Z = 10:00 a. m.
    expect(html).toMatch(/6 de noviembre de 2026/);
    expect(html).toContain('https://app.houndfe.test');
    expect(html).not.toMatch(/tel[eé]fono|wa:|5512345678/i);
  });

  it('omits the call to action without an app URL', () => {
    const html = renderToStaticMarkup(
      DeliveryZoneValidationEmail({ ...PROPS, appBaseUrl: undefined }),
    );
    expect(html).not.toContain('href=');
  });
});
