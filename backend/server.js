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
        const intentUrl = "intent://add-friend/" + u + "#Intent;scheme=newmusic;end";
        const customUrl = "newmusic://add-friend/" + u;
        window.location.href = customUrl;
        setTimeout(() => { window.location.href = intentUrl; }, 400);
      </script><style>body{background:#070B14;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px;}a{display:inline-block;padding:16px 32px;background:#4D8DFF;color:#fff;text-decoration:none;border-radius:28px;font-weight:bold;margin-top:20px;font-size:16px;box-shadow:0 8px 24px rgba(77,141,255,0.3);}</style></head><body><div><div style="font-size:48px;margin-bottom:12px;">🎵</div><h2>Sounddeep'te Arkadaş Ol!</h2><p style="color:#9A9A9A;font-size:14px;max-width:320px;margin:0 auto;">Birlikte müzik dinlemek ve ortak Blend listeleri oluşturmak için aşağıdaki butona dokun:</p><a href="intent://add-friend/${encodeURIComponent(user)}#Intent;scheme=newmusic;end">Uygulamada Aç ve Arkadaş Ekle</a></div></body></html>`);
    }

    // Şarkı veya Çalma listesi paylaşımı doğrudan uygulamada açma yönlendirmesi (Spotify tarzı kart & kapak)
    if (req.method === 'GET' && (path === '/song' || path.startsWith('/song/') || path.startsWith('/s/') || path === '/playlist' || path.startsWith('/playlist/') || path.startsWith('/p/'))) {
      const u = new URL(req.url, 'https://new-music-cpzw.onrender.com');
      const isPlaylist = path.startsWith('/playlist') || path.startsWith('/p/') || u.searchParams.get('playlist') === '1' || (u.searchParams.has('id') && !u.searchParams.has('v') && !path.startsWith('/s/'));

      if (isPlaylist) {
        const id = (path.startsWith('/p/') ? path.slice('/p/'.length) : '') || u.searchParams.get('id') || '';
        const name = u.searchParams.get('name') || 'Çalma Listesi';
        const user = u.searchParams.get('user') || u.searchParams.get('u') || '';
        const ytUrl = u.searchParams.get('url') || '';
        const cover = u.searchParams.get('cover') || '';
        const query = `name=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}&url=${encodeURIComponent(ytUrl)}&user=${encodeURIComponent(user)}`;
        const customUrl = `newmusic://playlist?${query}`;
        const intentUrl = `intent://playlist?${query}#Intent;scheme=newmusic;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end`;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
          <title>Sounddeep - ${name}</title>
          <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
          <meta property="og:site_name" content="Sounddeep">
          <meta property="og:title" content="${name} - Sounddeep Çalma Listesi">
          <meta property="og:description" content="Sounddeep uygulamasında bu çalma listesini aç ve dinle.">
          ${cover ? `<meta property="og:image" content="${cover}">` : ''}
          <meta name="twitter:card" content="summary_large_image">
          <script>
            function openApp() {
              try { window.location.href = "${customUrl}"; } catch(e) {}
              setTimeout(function() {
                try { window.location.href = "${intentUrl}"; } catch(e) {}
              }, 120);
            }
            openApp();
            document.addEventListener('DOMContentLoaded', openApp);
            window.addEventListener('load', openApp);
          </script>
          <style>
            * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
            body {
              background: #000000;
              color: #fff;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              padding: 20px;
            }
            .spotify-card {
              background: #121212;
              border: 1px solid rgba(255,255,255,0.08);
              border-radius: 24px;
              padding: 24px;
              max-width: 360px;
              width: 100%;
              text-align: center;
              box-shadow: 0 20px 50px rgba(0,0,0,0.8);
              cursor: pointer;
              transition: transform 0.15s ease, background 0.15s ease;
            }
            .spotify-card:active {
              transform: scale(0.97);
              background: #181818;
            }
            .cover-wrap {
              position: relative;
              width: 220px;
              height: 220px;
              margin: 0 auto 20px auto;
              border-radius: 16px;
              overflow: hidden;
              box-shadow: 0 12px 32px rgba(0,0,0,0.6);
              background: #1e1e1e;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            .cover-img {
              width: 100%;
              height: 100%;
              object-fit: cover;
              display: block;
            }
            .play-badge {
              position: absolute;
              bottom: 12px;
              right: 12px;
              width: 48px;
              height: 48px;
              background: #1ED760;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              box-shadow: 0 6px 16px rgba(0,0,0,0.4);
            }
            .play-badge svg {
              width: 22px;
              height: 22px;
              fill: #000;
              margin-left: 3px;
            }
            .title {
              font-size: 20px;
              font-weight: 700;
              margin: 0 0 6px 0;
              color: #fff;
              line-height: 1.3;
            }
            .subtitle {
              color: #b3b3b3;
              font-size: 14px;
              margin: 0 0 20px 0;
            }
            .btn {
              display: block;
              width: 100%;
              padding: 14px 20px;
              background: #1ED760;
              color: #000;
              text-decoration: none;
              border-radius: 28px;
              font-weight: 700;
              font-size: 15px;
              transition: opacity 0.15s;
            }
            .btn:active { opacity: 0.85; }
            .hint {
              color: #727272;
              font-size: 12px;
              margin-top: 14px;
              line-height: 1.4;
            }
          </style>
        </head>
        <body>
          <div class="spotify-card" onclick="openApp()" role="button" tabindex="0">
            <div class="cover-wrap">
              ${cover ? `<img src="${cover}" class="cover-img" alt="${name}">` : `<div style="font-size:64px;">🎶</div>`}
              <div class="play-badge">
                <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              </div>
            </div>
            <h2 class="title">${name}</h2>
            <p class="subtitle">${user ? user + ' • ' : ''}Sounddeep Çalma Listesi</p>
            <a href="${customUrl}" class="btn" onclick="openApp(); return false;">Sounddeep'te Dinle</a>
            <div class="hint">Kapağa veya butona dokunarak doğrudan Sounddeep'te açabilirsiniz.</div>
          </div>
        </body></html>`);
      }

      const pathSongId = path.startsWith('/s/') ? path.slice('/s/'.length) : (path.startsWith('/song/') ? path.slice('/song/'.length) : '');
      const v = pathSongId || (req.url.split('v=')[1] || '').split('&')[0];
      const title = u.searchParams.get('title') || 'Şarkıyı Dinle';
      const artist = u.searchParams.get('artist') || '';
      const fullTitle = artist ? `${title} – ${artist}` : title;
      const ytUrl = v ? 'https://www.youtube.com/watch?v=' + v : 'https://www.youtube.com';
      const thumb = v ? `https://i.ytimg.com/vi/${v}/hqdefault.jpg` : '';
      const customUrl = `newmusic://play?url=${encodeURIComponent(ytUrl)}`;
      const intentUrl = `intent://play?url=${encodeURIComponent(ytUrl)}#Intent;scheme=newmusic;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>Sounddeep - ${fullTitle}</title>
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
        <meta property="og:site_name" content="Sounddeep">
        <meta property="og:type" content="music.song">
        <meta property="og:title" content="${fullTitle}">
        <meta property="og:description" content="Sounddeep uygulamasında kesintisiz dinle.">
        ${thumb ? `<meta property="og:image" content="${thumb}"><meta property="og:image:width" content="480"><meta property="og:image:height" content="360">` : ''}
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content="${fullTitle}">
        ${thumb ? `<meta name="twitter:image" content="${thumb}">` : ''}
        <script>
          function openApp() {
            try { window.location.href = "${customUrl}"; } catch(e) {}
            setTimeout(function() {
              try { window.location.href = "${intentUrl}"; } catch(e) {}
            }, 120);
          }
          openApp();
          document.addEventListener('DOMContentLoaded', openApp);
          window.addEventListener('load', openApp);
        </script>
        <style>
          * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
          body {
            background: #000000;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
          }
          .spotify-card {
            background: #121212;
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 24px;
            padding: 24px;
            max-width: 360px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 50px rgba(0,0,0,0.8);
            cursor: pointer;
            transition: transform 0.15s ease, background 0.15s ease;
          }
          .spotify-card:active {
            transform: scale(0.97);
            background: #181818;
          }
          .cover-wrap {
            position: relative;
            width: 240px;
            height: 240px;
            margin: 0 auto 20px auto;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 12px 32px rgba(0,0,0,0.6);
            background: #1e1e1e;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .cover-img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
          }
          .play-badge {
            position: absolute;
            bottom: 12px;
            right: 12px;
            width: 48px;
            height: 48px;
            background: #1ED760;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 6px 16px rgba(0,0,0,0.4);
          }
          .play-badge svg {
            width: 22px;
            height: 22px;
            fill: #000;
            margin-left: 3px;
          }
          .title {
            font-size: 20px;
            font-weight: 700;
            margin: 0 0 6px 0;
            color: #fff;
            line-height: 1.3;
          }
          .artist {
            color: #b3b3b3;
            font-size: 15px;
            margin: 0 0 20px 0;
          }
          .btn {
            display: block;
            width: 100%;
            padding: 14px 20px;
            background: #1ED760;
            color: #000;
            text-decoration: none;
            border-radius: 28px;
            font-weight: 700;
            font-size: 15px;
            transition: opacity 0.15s;
          }
          .btn:active { opacity: 0.85; }
          .hint {
            color: #727272;
            font-size: 12px;
            margin-top: 14px;
            line-height: 1.4;
          }
        </style>
      </head>
      <body>
        <div class="spotify-card" onclick="openApp()" role="button" tabindex="0">
          <div class="cover-wrap">
            ${thumb ? `<img src="${thumb}" class="cover-img" alt="${title}">` : `<div style="font-size:64px;">🎵</div>`}
            <div class="play-badge">
              <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            </div>
          </div>
          <h2 class="title">${title}</h2>
          ${artist ? `<p class="artist">${artist}</p>` : ''}
          <a href="${customUrl}" class="btn" onclick="openApp(); return false;">Sounddeep'te Dinle</a>
          <div class="hint">Kapağa veya butona dokunarak doğrudan Sounddeep'te açabilirsiniz.</div>
        </div>
      </body></html>`);
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
