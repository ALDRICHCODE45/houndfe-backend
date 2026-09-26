import { loginOtpTemplate } from './login-otp.template';

describe('loginOtpTemplate', () => {
  it('preserves leading zeros and explains expiry in Spanish', () => {
    const mail = loginOtpTemplate('000001');
    expect(mail.html).toContain('<strong>000001</strong>');
    expect(mail.html).toContain('10 minutos');
    expect(mail.subject).not.toContain('000001');
  });

  it.each(['<script>', '12345', '１２３４５６'])(
    'rejects non-generated input %s',
    (code) => expect(() => loginOtpTemplate(code)).toThrow(),
  );
});
