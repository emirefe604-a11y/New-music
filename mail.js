// Sounddeep - e-posta gönderimi (doğrulama / şifre sıfırlama kodları)
//
// İki yoldan biri seçilir:
//  1) Brevo (önerilen, ücretsiz, HTTPS ile çalışır): BREVO_API_KEY + MAIL_FROM
//     Render ücretsiz pakette SMTP portları kapalıdır, bu yüzden bu yol daha güvenilirdir.
//  2) SMTP (Gmail uygulama şifresi vb.): SMTP_USER + SMTP_PASS (+ isteğe bağlı SMTP_HOST, SMTP_PORT)
//
// Hiçbiri ayarlı değilse e-posta kapalıdır: hesaplar e-postasız açılır, şifre sıfırlama çalışmaz.
// Deneme için MAIL_MODE=console yazarsan kodlar e-posta yerine sunucu loguna yazılır.
const APP_NAME = process.env.APP_NAME || 'Sounddeep';
const BREVO_KEY = process.env.BREVO_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || '';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const CONSOLE = process.env.MAIL_MODE === 'console';

let transporter = null;
if (!BREVO_KEY && SMTP_USER && SMTP_PASS) {
  try {
    transporter = require('nodemailer').createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
  } catch (e) { console.warn('nodemailer yüklenemedi:', e.message); }
}

const enabled = CONSOLE || Boolean(BREVO_KEY && MAIL_FROM) || Boolean(transporter);
if (!enabled) console.warn('E-posta ayarlı değil (BREVO_API_KEY + MAIL_FROM veya SMTP_USER + SMTP_PASS): e-posta doğrulaması/şifre sıfırlama kapalı.');

const SUBJECTS = {
  signup: 'hesabını doğrula',
  link: 'e-postanı doğrula',
  reset: 'şifre sıfırlama kodun'
};
const INTRO = {
  signup: 'Hesabını oluşturmak için doğrulama kodun:',
  link: 'E-postanı hesabına bağlamak için doğrulama kodun:',
  reset: 'Şifreni sıfırlamak için kodun:'
};

async function sendCode(to, code, purpose) {
  const subject = `${APP_NAME}: ${SUBJECTS[purpose] || 'doğrulama kodun'} ${code}`;
  const text = `${INTRO[purpose] || 'Doğrulama kodun:'} ${code}\n\nBu kod 10 dakika geçerlidir. Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px">
    <h2 style="color:#1565FF">${APP_NAME}</h2>
    <p>${INTRO[purpose] || 'Doğrulama kodun:'}</p>
    <p style="font-size:34px;letter-spacing:8px;font-weight:bold">${code}</p>
    <p style="color:#666">Bu kod 10 dakika geçerlidir. Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.</p></div>`;
  if (CONSOLE) { console.log(`[MAIL] ${to} <- ${purpose} kodu: ${code}`); return; }
  if (BREVO_KEY) {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: { name: APP_NAME, email: MAIL_FROM }, to: [{ email: to }], subject, htmlContent: html, textContent: text })
    });
    if (!r.ok) throw new Error('Brevo ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return;
  }
  await transporter.sendMail({ from: `"${APP_NAME}" <${MAIL_FROM}>`, to, subject, text, html });
}

module.exports = { enabled, sendCode };
