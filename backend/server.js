// Sounddeep - e-posta doğrulama kodu sunucusu
// POST /send-code  { email }        -> e-postaya 6 haneli kod gönderir
// POST /verify     { email, code }  -> kodu doğrular
const http = require('http');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT || 3000);
const SMTP_USER = process.env.SMTP_USER;            // gönderen Gmail adresi
const SMTP_PASS = process.env.SMTP_PASS;            // Gmail "uygulama şifresi"
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const APP_NAME = process.env.APP_NAME || 'Sounddeep';

const MAIL_ENABLED = Boolean(SMTP_USER && SMTP_PASS);
if (!MAIL_ENABLED) console.warn('SMTP_USER/SMTP_PASS yok: e-posta kodu kapalı, yalnızca sosyal özellikler çalışır.');

const transporter = MAIL_ENABLED ? nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;
const social = require('./social');

const CODE_TTL_MS = 10 * 60 * 1000;   // kod 10 dakika geçerli
const RESEND_MS = 30 * 1000;          // aynı adrese 30 sn'de bir kod
const MAX_ATTEMPTS = 5;               // en fazla 5 yanlış deneme
const IP_LIMIT = 20;                  // IP başına 10 dakikada en fazla 20 istek

const codes = new Map();   // email -> { hash, expires, attempts, sentAt }
const hits = new Map();    // ip -> { count, reset }

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function limited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset < now) { h = { count: 0, reset: now + 10 * 60 * 1000 }; hits.set(ip, h); }
  h.count += 1;
  return h.count > IP_LIMIT;
}

function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handleSend(res, body) {
  if (!MAIL_ENABLED) return send(res, 503, { error: 'E-posta gönderimi bu sunucuda ayarlı değil.' });
  const email = String(body.email || '').trim().toLowerCase();
  if (!isEmail(email)) return send(res, 400, { error: 'Geçerli bir e-posta adresi yaz.' });
  const old = codes.get(email);
  if (old && Date.now() - old.sentAt < RESEND_MS) {
    return send(res, 429, { error: 'Lütfen yeni kod istemeden önce biraz bekle.' });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  try {
    await transporter.sendMail({
      from: `"${APP_NAME}" <${SMTP_USER}>`,
      to: email,
      subject: `${APP_NAME} doğrulama kodun: ${code}`,
      text: `${APP_NAME} doğrulama kodun: ${code}\n\nBu kod 10 dakika geçerlidir. Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px">
        <h2 style="color:#1565FF">${APP_NAME}</h2>
        <p>Doğrulama kodun:</p>
        <p style="font-size:34px;letter-spacing:8px;font-weight:bold">${code}</p>
        <p style="color:#666">Bu kod 10 dakika geçerlidir. Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.</p></div>`
    });
  } catch (e) {
    console.error('Mail gönderilemedi:', e.message);
    return send(res, 502, { error: 'E-posta gönderilemedi. Daha sonra tekrar dene.' });
  }
  codes.set(email, { hash: sha(code), expires: Date.now() + CODE_TTL_MS, attempts: 0, sentAt: Date.now() });
  send(res, 200, { ok: true });
}

function handleVerify(res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const entry = codes.get(email);
  if (!entry || entry.expires < Date.now()) return send(res, 400, { error: 'Kodun süresi dolmuş. Yeni kod iste.' });
  if (entry.attempts >= MAX_ATTEMPTS) { codes.delete(email); return send(res, 429, { error: 'Çok fazla yanlış deneme. Yeni kod iste.' }); }
  entry.attempts += 1;
  const a = Buffer.from(sha(code)), b = Buffer.from(entry.hash);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    codes.delete(email);
    return send(res, 200, { ok: true });
  }
  send(res, 400, { error: 'Kod yanlış. Tekrar dene.' });
}

http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (req.method === 'GET' && req.url === '/') return send(res, 200, { ok: true, service: 'newmusic-auth', social: true });
  if (req.method !== 'POST') return send(res, 404, { error: 'Bulunamadı' });
  const isSocial = req.url.startsWith('/social/');
  if (!isSocial && limited(ip)) return send(res, 429, { error: 'Çok fazla istek. Biraz sonra tekrar dene.' });
  try {
    const path = req.url.split('?')[0];
    const body = await readJson(req, path.startsWith('/social/') ? 200 * 1024 : 2048);
    if (await social.handle(req, res, path, body, ip, send)) return;
    if (req.url === '/send-code') return await handleSend(res, body);
    if (req.url === '/verify') return handleVerify(res, body);
    send(res, 404, { error: 'Bulunamadı' });
  } catch (e) {
    send(res, 400, { error: 'Geçersiz istek.' });
  }
}).listen(PORT, () => console.log(`Sounddeep auth sunucusu ${PORT} portunda`));

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 60 * 1000).unref();
