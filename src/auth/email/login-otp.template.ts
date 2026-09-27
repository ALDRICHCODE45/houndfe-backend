/** Only generated ASCII digits enter this template; never interpolate user data. */
export function loginOtpTemplate(code: string): {
  subject: string;
  html: string;
} {
  if (!/^[0-9]{6}$/.test(code)) throw new Error('Invalid login code format');
  return {
    subject: 'Tu código de acceso a Houndfe',
    html: `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin: 0; padding: 0; background-color: #f5f4f7; color: #443d4e; font-family: 'Trebuchet MS', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; background-color: #f5f4f7;">
    <tbody>
      <tr>
        <td align="center" style="padding: 24px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px; border: 1px solid #eceaf0; border-radius: 14px; background-color: #ffffff;">
            <tbody>
              <tr>
                <td style="padding: 24px 20px; border-bottom: 1px solid #eceaf0;">
                  <p style="margin: 0; color: #2c2434; font-size: 20px; line-height: 28px; font-weight: 700;">Houndfe</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 28px 20px;">
                  <h1 style="margin: 0 0 20px; color: #2c2434; font-size: 24px; line-height: 32px; font-weight: 700;">Tu código de acceso es:</h1>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border: 1px solid #eceaf0; border-radius: 10px; background-color: #fbfafc;">
                    <tbody>
                      <tr>
                        <td align="center" style="padding: 20px 8px; color: #2c2434; font-family: 'Courier New', Courier, monospace; font-size: 36px; line-height: 44px; letter-spacing: 4px; white-space: nowrap;">
                          <strong>${code}</strong>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p style="margin: 20px 0 0; color: #443d4e; font-size: 16px; line-height: 24px;">Vence en 10 minutos. No lo compartas con nadie.</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 20px; border-top: 1px solid #eceaf0;">
                  <p style="margin: 0; color: #443d4e; font-size: 14px; line-height: 22px;">Si no solicitaste este código, ignora este correo.</p>
                </td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>
    </tbody>
  </table>
</body>
</html>`,
  };
}
