import { toStaffPhone } from './staff-phone';

const withPhone = { can: () => true };
const withoutPhone = { can: () => false };
/** Only the one permission this serializer may ask about. */
const onlyPhoneRead = {
  can: (action: string, subject: string) =>
    action === 'read' && subject === 'CustomerPhone',
};

describe('toStaffPhone (R12, D11)', () => {
  it('masks to area code and last four without read:CustomerPhone', () => {
    expect(
      toStaffPhone({ countryCode: '52', phone: '5512345678' }, withoutPhone),
    ).toBe('55 **** 5678');
  });

  it('returns the full E.164 number with read:CustomerPhone', () => {
    expect(
      toStaffPhone({ countryCode: '52', phone: '5512345678' }, onlyPhoneRead),
    ).toBe('+525512345678');
    expect(
      toStaffPhone({ countryCode: '52', phone: '5512345678' }, withPhone),
    ).toBe('+525512345678');
  });

  it('does not let another permission unmask it', () => {
    const everythingButPhone = {
      can: (_action: string, subject: string) => subject !== 'CustomerPhone',
    };
    expect(
      toStaffPhone(
        { countryCode: '52', phone: '5512345678' },
        everythingButPhone,
      ),
    ).toBe('55 **** 5678');
  });

  it('normalizes the WhatsApp 521 form and typed separators like canonicalPhone', () => {
    const masked = '55 **** 5678';
    expect(
      toStaffPhone({ countryCode: '521', phone: '5512345678' }, withoutPhone),
    ).toBe(masked);
    expect(
      toStaffPhone({ countryCode: '+52', phone: '55 1234-5678' }, withoutPhone),
    ).toBe(masked);
    expect(
      toStaffPhone({ countryCode: '521', phone: '5512345678' }, withPhone),
    ).toBe('+525512345678');
  });

  it('is null when there is no phone', () => {
    expect(
      toStaffPhone({ countryCode: null, phone: null }, withPhone),
    ).toBeNull();
    expect(
      toStaffPhone({ countryCode: null, phone: null }, withoutPhone),
    ).toBeNull();
  });

  it('shows only the last two digits of a short national number', () => {
    const short = { countryCode: '507', phone: '6123456' };
    expect(toStaffPhone(short, withoutPhone)).toBe('**** 56');
    expect(toStaffPhone(short, withPhone)).toBe('+5076123456');
  });

  it('never exposes more than six digits when masked', () => {
    const masked = toStaffPhone(
      { countryCode: '52', phone: '5512345678' },
      withoutPhone,
    );
    expect(masked?.replace(/\D/g, '')).toHaveLength(6);
  });
});
