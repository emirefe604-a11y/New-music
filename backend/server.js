// Sounddeep sunucusu: hesaplar (e-posta + şifre), e-posta kodu, arkadaşlar, profil fotoğrafı, liste paylaşımı, Blend
//   /auth/*    -> accounts.js  (hesap oluştur / giriş / şifre sıfırla)
//   /social/*  -> social.js    (arkadaşlar, çevrim içi bilgisi, paylaşım, Blend)
// E-posta gönderimi mail.js'tedir (BREVO_API_KEY + MAIL_FROM  veya  SMTP_USER + SMTP_PASS).
const http = require('http');
const accounts = require('./accounts');
const social = require('./social');
const mail = require('./mail');

const PORT = Number(process.env.PORT || 3000);

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

class BadRequest extends Error {}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new BadRequest('Gönderilen veri çok büyük.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const v = JSON.parse(text || '{}');
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
        resolve(v);
      } catch (e) { reject(new BadRequest('İstek okunamadı (JSON bozuk).')); }
    });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const path = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && path === '/') {
      return send(res, 200, { ok: true, service: 'newmusic', accounts: true, social: true, mail: mail.enabled, persistent: social.persistent });
    }
    if (req.method === 'GET' && path.startsWith('/social/avatar/')) return await social.serveAvatar(req, res);
    if (req.method !== 'POST') return send(res, 404, { error: 'Bulunamadı' });

    const limit = path === '/social/library-set' ? 1024 * 1024 : path.startsWith('/social/') ? 200 * 1024 : 8 * 1024;
    const body = await readJson(req, limit);
    if (await accounts.handle(req, res, path, body, ip, send)) return;
    if (await social.handle(req, res, path, body, ip, send)) return;
    send(res, 404, { error: 'Bulunamadı' });
  } catch (e) {
    if (e instanceof BadRequest) return send(res, 400, { error: e.message });
    // Gerçek sunucu hatası: nedeni loga yaz, uygulamaya "Geçersiz istek" yerine doğru bilgiyi ver
    console.error('Sunucu hatası', req.method, path, e && e.stack || e);
    if (!res.headersSent) send(res, 500, { error: 'Sunucu hatası. Biraz sonra tekrar dene.' });
  }
}).listen(PORT, () => console.log(`Sounddeep sunucusu ${PORT} portunda`));

// Render yeniden başlatırken bekleyen değişiklikleri kaydet
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { await social.flushNow(); } catch (e) { /* kapanıyoruz */ }
    process.exit(0);
  });
}
