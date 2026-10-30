// Sounddeep - sosyal özellikler: arkadaşlar, çevrim içi/dışı bilgisi, liste paylaşımı
// Tüm uç noktalar POST'tur. /social/join dışındakiler "Authorization: Bearer <token>" ister.
//
//  /social/join            { username }                    -> { token, username }
//  /social/heartbeat       { playing? }                    -> { ok }       (uygulama açıkken ~30 sn'de bir; playing = şu an çalan şarkı)
//  /social/avatar-set      { image: base64 JPEG }          -> { ok, avatar }
//  /social/avatar-clear    {}                              -> { ok }
//  GET /social/avatar/<id>                                 -> JPEG (id tahmin edilemez, arkadaşın listesinde görünür)
//  /social/rename          { username }                    -> { ok, username }
//  /social/offline         {}                              -> { ok }       (uygulama kapanırken)
//  /social/friends         {}                              -> { friends, incoming, outgoing }
//  /social/friend-request  { username }                    -> { ok }
//  /social/friend-respond  { username, accept }            -> { ok }
//  /social/friend-remove   { username }                    -> { ok }
//  /social/share           { to: [username], name, songs } -> { ok, sent }
//  /social/inbox           {}                              -> { items }
//  /social/inbox-dismiss   { id }                          -> { ok }
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || './social-data.json';
// Kalıcı depolama (ücretsiz): Upstash Redis. İki değişken de doluysa kullanılır, yoksa dosyaya yazılır.
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

const ONLINE_MS = 50 * 1000;      // son sinyalden bu yana 50 sn geçmediyse "çevrim içi" (uygulama 5-15 sn'de bir sinyal yollar)
const AVATAR_DIR = process.env.AVATAR_DIR || './social-avatars';
const AVATAR_MAX = 64 * 1024;     // profil fotoğrafı en fazla 64 KB (uygulama 256x256 JPEG yollar)
const MAX_SONGS = 100;
const MAX_INBOX = 20;
const JOIN_LIMIT = 5;             // IP başına 10 dakikada en fazla 5 hesap

// users: username(lowercase) -> { username, tokenHash, lastSeen, friends:[lc], incoming:[lc], outgoing:[lc], inbox:[...] }
// lastSeen yalnızca bellekte tutulur (kaydedilmez): böylece her sinyal veritabanına yazı yapmaz.
const users = {};
const MEMORY_ONLY = new Set(['lastSeen', 'playing', 'renamedAt', 'avatarAt']);   // bellekte kalır, veritabanına yazılmaz
const ser = (u) => JSON.stringify(u, (k, v) => (MEMORY_ONLY.has(k) ? undefined : v));
const removed = new Set();   // adı değişen kullanıcıların eski anahtarları

async function redis(cmds) {
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('Redis ' + r.status);
  const out = await r.json();
  const bad = out.find((x) => x && x.error);
  if (bad) throw new Error('Redis: ' + bad.error);
  return out;
}

async function loadAll() {
  if (useRedis) {
    const [m] = await redis([['SMEMBERS', 'users']]);
    const names = m.result || [];
    for (let i = 0; i < names.length; i += 100) {
      const chunk = names.slice(i, i + 100);
      const [res] = await redis([['MGET', ...chunk.map((n) => 'u:' + n)]]);
      (res.result || []).forEach((v) => {
        if (!v) return;
        try { const u = JSON.parse(v); u.lastSeen = 0; users[String(u.username).toLowerCase()] = u; } catch (e) { /* bozuk kayıt */ }
      });
    }
  } else {
    try {
      const all = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const [k, u] of Object.entries(all)) { u.lastSeen = 0; users[k] = u; }
    } catch (e) { /* ilk çalışma */ }
  }
}

let loaded = false, loadPromise = null;
async function ensureLoaded() {
  if (loaded) return true;
  try { await (loadPromise = loadPromise || loadAll()); loaded = true; return true; }
  catch (e) { loadPromise = null; console.error('Veri yüklenemedi:', e.message); return false; }
}

// ---- Profil fotoğrafları: Redis'te "a:<id>" (base64), Redis yoksa dosyada ----
const avatarCache = new Map();
function cachePut(id, buf) {
  avatarCache.set(id, buf);
  if (avatarCache.size > 200) avatarCache.delete(avatarCache.keys().next().value);
}
async function blobGet(id) {
  if (useRedis) {
    const [r] = await redis([['GET', 'a:' + id]]);
    return r.result ? Buffer.from(r.result, 'base64') : null;
  }
  try { return await fs.promises.readFile(path.join(AVATAR_DIR, id + '.jpg')); } catch (e) { return null; }
}
async function blobSet(id, buf) {
  if (useRedis) { await redis([['SET', 'a:' + id, buf.toString('base64')]]); return; }
  await fs.promises.mkdir(AVATAR_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(AVATAR_DIR, id + '.jpg'), buf);
}
async function blobDel(id) {
  if (useRedis) { await redis([['DEL', 'a:' + id]]); return; }
  try { await fs.promises.unlink(path.join(AVATAR_DIR, id + '.jpg')); } catch (e) { /* yok */ }
}

async function serveAvatar(req, res) {
  const id = req.url.split('?')[0].slice('/social/avatar/'.length);
  const notFound = () => { res.writeHead(404); res.end(); };
  if (!/^[a-f0-9]{16}$/.test(id)) return notFound();
  let buf = avatarCache.get(id);
  if (!buf) {
    try { buf = await blobGet(id); } catch (e) { res.writeHead(503); return res.end(); }
    if (!buf) return notFound();
    cachePut(id, buf);
  }
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',   // id her yüklemede değişir
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'"
  });
  res.end(buf);
}

const dirty = new Set();
let timer = null;
function touch(...us) {
  for (const u of us) if (u) dirty.add(String(u.username).toLowerCase());
  if (!timer) timer = setTimeout(flush, 1000);
}
async function flush(retryMs) {
  timer = null;
  const names = [...dirty];
  dirty.clear();
  const gone = [...removed].filter((n) => !users[n]);   // eski ad başkası tarafından alındıysa silme
  removed.clear();
  if (names.length === 0 && gone.length === 0) return;
  try {
    if (useRedis) {
      const cmds = [];
      for (const n of gone) { cmds.push(['DEL', 'u:' + n]); cmds.push(['SREM', 'users', n]); }
      for (const n of names) if (users[n]) { cmds.push(['SET', 'u:' + n, ser(users[n])]); cmds.push(['SADD', 'users', n]); }
      if (cmds.length) await redis(cmds);
    } else {
      await fs.promises.writeFile(DATA_FILE, ser(users));
    }
  } catch (e) {
    console.error('Kayıt hatası:', e.message);
    names.forEach((n) => dirty.add(n));
    gone.forEach((n) => removed.add(n));
    if (!timer) timer = setTimeout(flush, 10000);   // 10 sn sonra tekrar dene
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const lc = (s) => String(s || '').trim().toLowerCase();
const validName = (s) => /^[a-zA-Z0-9_.]{3,20}$/.test(s);
const joinHits = new Map();

function authUser(req) {
  const h = String(req.headers['authorization'] || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const th = sha(token);
  for (const u of Object.values(users)) {
    const a = Buffer.from(u.tokenHash), b = Buffer.from(th);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return u;
  }
  return null;
}

const isOnline = (u) => u.lastSeen > 0 && Date.now() - u.lastSeen < ONLINE_MS;
const view = (u) => {
  const v = { username: u.username, online: isOnline(u), lastSeen: u.lastSeen || 0, avatar: u.avatar || null };
  if (v.online && u.playing) v.listening = u.playing;   // yalnızca çevrim içiyken gösterilir
  return v;
};

function snapshot(me) {
  const list = (arr) => arr.map((n) => users[n]).filter(Boolean);
  return {
    me: { username: me.username, avatar: me.avatar || null },
    friends: list(me.friends).map(view),
    incoming: list(me.incoming).map((u) => ({ username: u.username, avatar: u.avatar || null })),
    outgoing: list(me.outgoing).map((u) => ({ username: u.username, avatar: u.avatar || null })),
    inbox: me.inbox.length
  };
}

function cleanPlaying(p) {
  if (!p || typeof p !== 'object' || typeof p.title !== 'string' || !p.title) return null;
  const url = typeof p.url === 'string' && !p.url.startsWith('local://') && p.url.length <= 300 ? p.url : '';
  return { title: p.title.slice(0, 150), artist: String(p.artist || '').slice(0, 100), url, thumb: p.thumb ? String(p.thumb).slice(0, 300) : null };
}
const without = (arr, x) => arr.filter((v) => v !== x);

function cleanSongs(songs) {
  if (!Array.isArray(songs)) return [];
  const seen = new Set();
  const out = [];
  for (const s of songs.slice(0, MAX_SONGS)) {
    if (!s || typeof s.url !== 'string' || !s.url) continue;
    if (s.url.startsWith('local://')) continue;        // cihazdaki yüklenen dosyalar paylaşılamaz
    if (s.url.length > 300 || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({
      title: String(s.title || '').slice(0, 150),
      artist: String(s.artist || '').slice(0, 100),
      url: s.url,
      thumb: s.thumb ? String(s.thumb).slice(0, 300) : null
    });
  }
  return out;
}

// handle: yönetildiyse true döner. reply(status, obj) sunucudan gelir.
async function handle(req, res, path, body, ip, reply) {
  if (!path.startsWith('/social/')) return false;
  if (!(await ensureLoaded())) { reply(res, 503, { error: 'Sunucu veritabanına ulaşamıyor. Biraz sonra tekrar dene.' }); return true; }

  if (path === '/social/join') {
    const now = Date.now();
    let h = joinHits.get(ip);
    if (!h || h.reset < now) { h = { count: 0, reset: now + 10 * 60 * 1000 }; joinHits.set(ip, h); }
    if (++h.count > JOIN_LIMIT) { reply(res, 429, { error: 'Çok fazla deneme. Biraz sonra tekrar dene.' }); return true; }
    const name = String(body.username || '').trim();
    if (!validName(name)) { reply(res, 400, { error: 'Kullanıcı adı 3-20 karakter olmalı (harf, rakam, _ ve .).' }); return true; }
    if (users[lc(name)]) { reply(res, 409, { error: 'Bu kullanıcı adı alınmış.' }); return true; }
    const token = crypto.randomBytes(24).toString('hex');
    users[lc(name)] = { username: name, tokenHash: sha(token), lastSeen: Date.now(), friends: [], incoming: [], outgoing: [], inbox: [] };
    touch(users[lc(name)]);
    reply(res, 200, { token, username: name });
    return true;
  }

  const me = authUser(req);
  if (!me) { reply(res, 401, { error: 'Oturum geçersiz. Sosyal hesabını yeniden oluştur.' }); return true; }

  switch (path) {
    case '/social/heartbeat':
      me.lastSeen = Date.now();
      me.playing = cleanPlaying(body.playing);   // gönderilmezse "dinlemiyor" sayılır
      reply(res, 200, Object.assign({ ok: true }, snapshot(me)));
      return true;

    case '/social/offline':
      me.lastSeen = Date.now() - ONLINE_MS;   // çevrim dışı say ama son görülme zamanı kalsın
      me.playing = null;
      reply(res, 200, { ok: true });
      return true;

    case '/social/friends':
      reply(res, 200, snapshot(me));
      return true;

    case '/social/friend-request': {
      const t = users[lc(body.username)];
      if (!t) { reply(res, 404, { error: 'Böyle bir kullanıcı yok.' }); return true; }
      const a = lc(me.username), b = lc(t.username);
      if (a === b) { reply(res, 400, { error: 'Kendine istek gönderemezsin.' }); return true; }
      if (me.friends.includes(b)) { reply(res, 400, { error: 'Zaten arkadaşsınız.' }); return true; }
      if (me.outgoing.includes(b)) { reply(res, 400, { error: 'İstek zaten gönderilmiş.' }); return true; }
      if (me.incoming.includes(b)) {   // karşı taraf zaten istek atmışsa direkt arkadaş ol
        me.incoming = without(me.incoming, b); t.outgoing = without(t.outgoing, a);
        me.friends.push(b); t.friends.push(a);
      } else {
        me.outgoing.push(b); t.incoming.push(a);
      }
      touch(me, t);
      reply(res, 200, { ok: true });
      return true;
    }

    case '/social/friend-respond': {
      const t = users[lc(body.username)];
      const a = lc(me.username), b = t ? lc(t.username) : '';
      if (!t || !me.incoming.includes(b)) { reply(res, 404, { error: 'İstek bulunamadı.' }); return true; }
      me.incoming = without(me.incoming, b); t.outgoing = without(t.outgoing, a);
      if (body.accept === true) { me.friends.push(b); t.friends.push(a); }
      touch(me, t);
      reply(res, 200, { ok: true });
      return true;
    }

    case '/social/friend-remove': {
      const b = lc(body.username), a = lc(me.username);
      const t = users[b];
      me.friends = without(me.friends, b); me.outgoing = without(me.outgoing, b); me.incoming = without(me.incoming, b);
      if (t) { t.friends = without(t.friends, a); t.outgoing = without(t.outgoing, a); t.incoming = without(t.incoming, a); }
      touch(me, t);
      reply(res, 200, { ok: true });
      return true;
    }

    case '/social/share': {
      const songs = cleanSongs(body.songs);
      if (songs.length === 0) { reply(res, 400, { error: 'Paylaşılacak şarkı yok. Cihazdan yüklenen şarkılar paylaşılamaz.' }); return true; }
      const targets = Array.isArray(body.to) ? body.to.slice(0, 20) : [];
      let sent = 0;
      const changed = [];
      for (const n of targets) {
        const t = users[lc(n)];
        if (!t || !me.friends.includes(lc(t.username))) continue;   // yalnızca arkadaşlara
        t.inbox.unshift({
          id: crypto.randomBytes(6).toString('hex'),
          from: me.username,
          name: String(body.name || 'Liste').slice(0, 40),
          songs,
          at: Date.now()
        });
        t.inbox = t.inbox.slice(0, MAX_INBOX);
        changed.push(t);
        sent++;
      }
      touch(...changed);
      reply(res, 200, { ok: true, sent });
      return true;
    }

    case '/social/rename': {
      const name = String(body.username || '').trim();
      if (!validName(name)) { reply(res, 400, { error: 'Kullanıcı adı 3-20 karakter olmalı (harf, rakam, _ ve .).' }); return true; }
      if (Date.now() - (me.renamedAt || 0) < 60 * 1000) { reply(res, 429, { error: 'Adı çok sık değiştiremezsin. Biraz bekle.' }); return true; }
      const oldKey = lc(me.username), newKey = lc(name);
      if (newKey === oldKey) {            // yalnızca büyük/küçük harf değişti
        me.username = name; me.renamedAt = Date.now(); touch(me);
        reply(res, 200, { ok: true, username: name });
        return true;
      }
      if (users[newKey]) { reply(res, 409, { error: 'Bu kullanıcı adı alınmış.' }); return true; }
      delete users[oldKey];
      users[newKey] = me;
      removed.add(oldKey);
      const others = new Set([...me.friends, ...me.incoming, ...me.outgoing]);
      const changed = [];
      for (const k of others) {            // arkadaşların listelerindeki eski adı yenisiyle değiştir
        const o = users[k];
        if (!o) continue;
        for (const f of ['friends', 'incoming', 'outgoing']) o[f] = o[f].map((x) => (x === oldKey ? newKey : x));
        changed.push(o);
      }
      me.username = name;
      me.renamedAt = Date.now();
      touch(me, ...changed);
      reply(res, 200, { ok: true, username: name });
      return true;
    }

    case '/social/avatar-set': {
      if (Date.now() - (me.avatarAt || 0) < 3000) { reply(res, 429, { error: 'Biraz bekleyip tekrar dene.' }); return true; }
      const b64 = String(body.image || '');
      if (b64.length > 100000) { reply(res, 400, { error: 'Fotoğraf çok büyük.' }); return true; }
      const buf = Buffer.from(b64, 'base64');
      const jpeg = buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      if (!jpeg || buf.length > AVATAR_MAX) { reply(res, 400, { error: 'Geçersiz fotoğraf.' }); return true; }
      const id = crypto.randomBytes(8).toString('hex');
      try { await blobSet(id, buf); } catch (e) { console.error('Fotoğraf kaydı:', e.message); reply(res, 503, { error: 'Fotoğraf kaydedilemedi. Tekrar dene.' }); return true; }
      const old = me.avatar;
      me.avatar = id; me.avatarAt = Date.now();
      cachePut(id, buf);
      touch(me);
      if (old) { avatarCache.delete(old); blobDel(old).catch(() => {}); }
      reply(res, 200, { ok: true, avatar: id });
      return true;
    }

    case '/social/avatar-clear': {
      const old = me.avatar;
      me.avatar = null;
      touch(me);
      if (old) { avatarCache.delete(old); blobDel(old).catch(() => {}); }
      reply(res, 200, { ok: true });
      return true;
    }

    case '/social/inbox':
      reply(res, 200, { items: me.inbox });
      return true;

    case '/social/inbox-dismiss':
      me.inbox = me.inbox.filter((i) => i.id !== body.id);
      touch(me);
      reply(res, 200, { ok: true });
      return true;

    default:
      reply(res, 404, { error: 'Bulunamadı' });
      return true;
  }
}

module.exports = { handle, serveAvatar };
