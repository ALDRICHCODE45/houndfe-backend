/** Only generated ASCII digits enter this template; never interpolate user data. */
export function loginOtpTemplate(code: string): {
  subject: string;
  html: string;
} {
  if (!/^[0-9]{6}$/.test(code)) throw new Error('Invalid login code format');
  return {
    subject: 'Tu código de acceso a Houndfe',
    html: `<p>Tu código de acceso es:</p><p><strong>${code}</strong></p><p>Vence en 10 minutos. No lo compartas con nadie.</p><p>Si no solicitaste este código, ignora este correo.</p>`,
  };
}
