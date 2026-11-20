import {
  formatTicketMethod,
  formatTicketQuantity,
  softBreakLongTokens,
} from './ticket-format';

describe('ticket-format', () => {
  describe('formatTicketQuantity', () => {
    it.each([
      [1, '1'],
      [12, '12'],
      [2.5, '2.5'],
      [1.5, '1.5'],
      [0.25, '0.25'],
    ])('prints %p as %p', (quantity, expected) => {
      expect(formatTicketQuantity(quantity)).toBe(expected);
    });
  });

  describe('formatTicketMethod', () => {
    it('maps the base codes and leaves unknown ones as-is', () => {
      expect(formatTicketMethod('cash')).toBe('Efectivo');
      expect(formatTicketMethod('CARD')).toBe('Tarjeta');
      expect(formatTicketMethod('TRANSFER')).toBe('Transferencia');
      expect(formatTicketMethod('VALES')).toBe('VALES');
    });
  });

  describe('softBreakLongTokens', () => {
    it('leaves ordinary names (words under 18 chars) untouched', () => {
      const name =
        'Croquetas Premium Adulto Raza Grande Pollo y Arroz Hipoalergénico';

      expect(softBreakLongTokens(name)).toBe(name);
    });

    it('adds invisible break points inside a long unbroken token', () => {
      const token = 'X'.repeat(50);
      const result = softBreakLongTokens(`Caja ${token}`);

      expect(result).toContain('\u00AD');
      expect(result.replace(/\u00AD/g, '')).toBe(`Caja ${token}`);
      for (const part of result.split(/[\s\u00AD]/)) {
        expect(part.length).toBeLessThanOrEqual(12);
      }
    });
  });
});
