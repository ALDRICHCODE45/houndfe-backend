/**
 * shipping-zones / T2 (S5) — sucursal shipping settings use ShippingSettings.
 */
import { ShippingSettingsController } from './shipping-settings.controller';

describe('ShippingSettingsController — permission metadata', () => {
  const table: Array<[keyof ShippingSettingsController, string[][]]> = [
    ['listBoxes', [['read', 'ShippingSettings']]],
    ['createBox', [['update', 'ShippingSettings']]],
    ['updateBox', [['update', 'ShippingSettings']]],
    ['deleteBox', [['update', 'ShippingSettings']]],
    ['getOrigin', [['read', 'ShippingSettings']]],
    ['putOrigin', [['update', 'ShippingSettings']]],
  ];

  it.each(table)('%s requires exactly %j', (method, expected) => {
    const handler = ShippingSettingsController.prototype[method];
    expect(Reflect.getMetadata('required_permissions', handler)).toEqual(
      expected,
    );
  });
});
