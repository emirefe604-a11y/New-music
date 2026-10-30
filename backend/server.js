// Sounddeep sunucusu - hesap (kullanıcı adı + şifre), arkadaşlar, çevrim içi bilgisi, yedek, Blend, liste paylaşımı
// Tüm uç noktalar social.js içindedir (/social/...). E-posta ile giriş kaldırıldı; SMTP ayarı gerekmez.
const http = require('http');
const social = require('./social');

const PORT = Number(process.env.PORT || 3000);

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (req.method === 'GET' && req.url === '/') return send(res, 200, { ok: true, service: 'newmusic', social: true });
  if (req.method === 'GET' && req.url.startsWith('/social/avatar/')) {
    if (await social.handleGet(req, res, req.url.split('?')[0])) return;
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Bulunamadı' });
  try {
    const path = req.url.split('?')[0];
    const body = await readJson(req, path === '/social/data-put' ? 1024 * 1024 : 200 * 1024);
    if (await social.handle(req, res, path, body, ip, send)) return;
    send(res, 404, { error: 'Bulunamadı' });
  } catch (e) {
    send(res, 400, { error: 'Geçersiz istek.' });
  }
}).listen(PORT, () => console.log(`Sounddeep sunucusu ${PORT} portunda`));
