import type { ShippingAddressSnapshot } from './shipping-address-snapshot';
import {
  SHIPPING_ADDRESS_SNAPSHOT_KEYS,
  compareShippingAddressSource,
} from './shipping-address-source-status';

const snapshot: ShippingAddressSnapshot = {
  street: 'Original Street',
  exteriorNumber: '12',
  interiorNumber: null,
  zipCode: '64000',
  neighborhood: 'Centro',
  municipality: 'Monterrey',
  city: 'Monterrey',
  state: 'Nuevo Leon',
  visualReferences: 'Blue gate',
  carrierPhone: '5512345678',
  label: 'Home',
  latitude: 25.68,
  longitude: -100.31,
};

const changedValue: Record<keyof ShippingAddressSnapshot, unknown> = {
  street: 'Edited Street',
  exteriorNumber: '13',
  interiorNumber: 'B',
  zipCode: '99999',
  neighborhood: 'Obispado',
  municipality: 'San Pedro',
  city: 'San Pedro',
  state: 'Coahuila',
  visualReferences: 'Red gate',
  carrierPhone: '5599999999',
  label: 'Office',
  latitude: 25.6800001,
  longitude: -100.3100001,
};

describe('compareShippingAddressSource', () => {
  it('fixes the 13 snapshot keys in wire order', () => {
    expect(SHIPPING_ADDRESS_SNAPSHOT_KEYS).toEqual([
      'street',
      'exteriorNumber',
      'interiorNumber',
      'zipCode',
      'neighborhood',
      'municipality',
      'city',
      'state',
      'visualReferences',
      'carrierPhone',
      'label',
      'latitude',
      'longitude',
    ]);
  });

  it('is UNCHANGED when all 13 fields are equal, ignoring extra live columns', () => {
    const live = {
      ...snapshot,
      id: 'address-1',
      tenantId: 'tenant-1',
      updatedAt: new Date(),
    };
    expect(compareShippingAddressSource(snapshot, live)).toEqual({
      sourceStatus: 'UNCHANGED',
      changedFields: [],
    });
  });

  it.each(SHIPPING_ADDRESS_SNAPSHOT_KEYS)(
    'is CHANGED when %s differs',
    (key) => {
      const live = { ...snapshot, [key]: changedValue[key] };
      expect(compareShippingAddressSource(snapshot, live)).toEqual({
        sourceStatus: 'CHANGED',
        changedFields: [key],
      });
    },
  );

  it('treats a label-only change as CHANGED', () => {
    expect(
      compareShippingAddressSource(snapshot, { ...snapshot, label: null }),
    ).toEqual({ sourceStatus: 'CHANGED', changedFields: ['label'] });
  });

  it('lists every differing key in the fixed order', () => {
    const live = {
      ...snapshot,
      longitude: 0,
      street: 'Edited Street',
      label: 'Office',
    };
    expect(compareShippingAddressSource(snapshot, live).changedFields).toEqual([
      'street',
      'label',
      'longitude',
    ]);
  });

  it('compares coordinates exactly, with no tolerance', () => {
    expect(
      compareShippingAddressSource(snapshot, {
        ...snapshot,
        latitude: snapshot.latitude! + Number.EPSILON * 32,
      }).changedFields,
    ).toEqual(['latitude']);
    expect(
      compareShippingAddressSource(snapshot, { ...snapshot, latitude: null })
        .changedFields,
    ).toEqual(['latitude']);
  });

  it('treats undefined as null on either side', () => {
    const live = { ...snapshot, interiorNumber: undefined };
    expect(compareShippingAddressSource(snapshot, live).sourceStatus).toBe(
      'UNCHANGED',
    );
    const loose = {
      ...snapshot,
      interiorNumber: undefined,
    } as unknown as ShippingAddressSnapshot;
    expect(
      compareShippingAddressSource(loose, { ...snapshot, interiorNumber: null })
        .sourceStatus,
    ).toBe('UNCHANGED');
  });

  it('does not coerce types or trim strings', () => {
    expect(
      compareShippingAddressSource(snapshot, {
        ...snapshot,
        exteriorNumber: '12 ',
      }).changedFields,
    ).toEqual(['exteriorNumber']);
    expect(
      compareShippingAddressSource(snapshot, {
        ...snapshot,
        interiorNumber: '',
      }).changedFields,
    ).toEqual(['interiorNumber']);
  });

  it.each([null, undefined])(
    'is DELETED when the live source is %s',
    (live) => {
      expect(compareShippingAddressSource(snapshot, live)).toEqual({
        sourceStatus: 'DELETED',
        changedFields: [],
      });
    },
  );
});
