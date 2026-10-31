// Sounddeep sunucusu: hesaplar (e-posta + şifre), e-posta kodu, arkadaşlar, profil fotoğrafı, liste paylaşımı, Blend
//   /auth/*    -> accounts.js  (hesap oluştur / giriş / şifre sıfırla)
//   /social/*  -> social.js    (arkadaşlar, çevrim içi bilgisi, paylaşım, Blend, profil müziği, durumlar)
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
    // WhatsApp ve web tarayıcıdan gelen arkadaş ekleme yönlendirmesi
    if (req.method === 'GET' && path.startsWith('/add-friend/')) {
      const user = decodeURIComponent(path.split('/')[2] || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sounddeep - Arkadaş Ekle</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta property="og:title" content="Beni Sounddeep'te arkadaş olarak ekle!"><meta property="og:description" content="Sounddeep uygulamasında tek tıkla arkadaş ol."><script>
        const u = "${encodeURIComponent(user)}";
        const intentUrl = "intent://add-friend/" + u + "#Intent;scheme=newmusic;package=com.example.newmusic;end";
        const customUrl = "newmusic://add-friend/" + u;
        window.location.href = customUrl;
        setTimeout(() => { window.location.href = intentUrl; }, 400);
      </script><style>body{background:#070B14;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px;}a{display:inline-block;padding:16px 32px;background:#4D8DFF;color:#fff;text-decoration:none;border-radius:28px;font-weight:bold;margin-top:20px;font-size:16px;box-shadow:0 8px 24px rgba(77,141,255,0.3);}</style></head><body><div><div style="font-size:48px;margin-bottom:12px;">🎵</div><h2>Sounddeep'te Arkadaş Ol!</h2><p style="color:#9A9A9A;font-size:14px;max-width:320px;margin:0 auto;">Birlikte müzik dinlemek ve ortak Blend listeleri oluşturmak için aşağıdaki butona dokun:</p><a href="intent://add-friend/${encodeURIComponent(user)}#Intent;scheme=newmusic;package=com.example.newmusic;end">Uygulamada Aç ve Arkadaş Ekle</a></div></body></html>`);
    }
        // Şarkı veya Çalma listesi paylaşımı doğrudan uygulamada açma yönlendirmesi
    if (req.method === 'GET' && (path === '/song' || path === '/playlist' || path.startsWith('/playlist/'))) {
      const u = new URL(req.url, 'https://new-music-cpzw.onrender.com');
      const isPlaylist = path.startsWith('/playlist') || u.searchParams.get('playlist') === '1' || (u.searchParams.has('id') && !u.searchParams.has('v'));
      if (isPlaylist) {
        const id = u.searchParams.get('id') || '';
        const name = u.searchParams.get('name') || 'Çalma Listesi';
        const user = u.searchParams.get('user') || '';
        const ytUrl = u.searchParams.get('url') || '';
        const query = `name=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}&url=${encodeURIComponent(ytUrl)}&user=${encodeURIComponent(user)}`;
        const customUrl = `newmusic://playlist?${query}`;
        const intentUrl = `intent://playlist?${query}#Intent;scheme=newmusic;package=com.example.newmusic;end`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sounddeep - ${name}</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta property="og:title" content="${name} - Sounddeep Çalma Listesi"><meta property="og:description" content="Sounddeep uygulamasında bu çalma listesini aç ve dinle."><script>
          window.location.href = "${customUrl}";
          setTimeout(() => { window.location.href = "${intentUrl}"; }, 300);
        </script><style>body{background:#070B14;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px;}a{display:inline-block;padding:16px 32px;background:#4D8DFF;color:#fff;text-decoration:none;border-radius:28px;font-weight:bold;margin-top:20px;font-size:16px;box-shadow:0 8px 24px rgba(77,141,255,0.3);}</style></head><body><div><div style="font-size:48px;margin-bottom:12px;">🎶</div><h2>${name}</h2><p style="color:#9A9A9A;font-size:14px;max-width:320px;margin:0 auto;">Bu listeyi Sounddeep uygulamasında açıp dinlemek için aşağıdaki butona dokun:</p><a href="${intentUrl}">Uygulamada Listeyi Aç</a></div></body></html>`);
      }
      const v = (req.url.split('v=')[1] || '').split('&')[0];
      const ytUrl = v ? 'https://www.youtube.com/watch?v=' + v : 'https://www.youtube.com';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sounddeep - Şarkıyı Dinle</title><meta name="viewport" content="width=device-width,initial-scale=1"><script>
        const yt = "${encodeURIComponent(ytUrl)}";
        const intentUrl = "intent://play?url=" + yt + "#Intent;scheme=newmusic;package=com.example.newmusic;end";
        const customUrl = "newmusic://play?url=" + yt;
        window.location.href = customUrl;
        setTimeout(() => { window.location.href = intentUrl; }, 300);
        setTimeout(() => { window.location.href = "${ytUrl}"; }, 1500);
      </script><style>body{background:#070B14;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px;}a{display:inline-block;padding:16px 32px;background:#4D8DFF;color:#fff;text-decoration:none;border-radius:28px;font-weight:bold;margin-top:20px;font-size:16px;box-shadow:0 8px 24px rgba(77,141,255,0.3);}</style></head><body><div><div style="font-size:48px;margin-bottom:12px;">🎵</div><h2>Şarkı Başlatılıyor...</h2><p style="color:#9A9A9A;font-size:14px;max-width:320px;margin:0 auto;">Sounddeep uygulamasında açmak için aşağıdaki butona dokun:</p><a href="intent://play?url=${encodeURIComponent(ytUrl)}#Intent;scheme=newmusic;package=com.example.newmusic;end">Uygulamada Dinle</a></div></body></html>`);
    }
if (req.method === 'GET' && path.startsWith('/social/avatar/')) return await social.serveAvatar(req, res);
    if (req.method !== 'POST') return send(res, 404, { error: 'Bulunamadı' });

    const limit = path === '/social/library-set' ? 1024 * 1024 : (path === '/social/avatar-set' || path === '/social/cover-set') ? 512 * 1024 : path.startsWith('/social/') ? 200 * 1024 : 8 * 1024;
    const body = await readJson(req, limit);
    if (await accounts.handle(req, res, path, body, ip, send)) return;
    if (await social.handle(req, res, path, body, ip, send)) return;
    send(res, 404, { error: 'Bulunamadı' });
  } catch (e) {
    if (e instanceof BadRequest) return send(res, 400, { error: e.message });
    console.error('Sunucu hatası', req.method, path, e && e.stack || e);
    if (!res.headersSent) send(res, 500, { error: 'Sunucu hatası. Biraz sonra tekrar dene.' });
  }
}).listen(PORT, () => console.log(`Sounddeep sunucusu ${PORT} portunda`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { await social.flushNow(); } catch (e) { /* kapanıyoruz */ }
    process.exit(0);
  });
}
