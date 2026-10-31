// Sounddeep - sosyal özellikler: arkadaşlar, çevrim içi/dışı bilgisi, liste paylaşımı
// Tüm uç noktalar POST'tur. /social/join dışındakiler "Authorization: Bearer <token>" ister.
//
//  /social/join            { username }                    -> { token, username }
//  /social/heartbeat       { playing? }                    -> { ok }       (uygulama açıkken ~30 sn'de bir; playing = şu an çalan şarkı)
//  /social/avatar-set      { image: base64 JPEG }          -> { ok, avatar }
//  /social/avatar-clear    {}                              -> { ok }
//  GET /social/avatar/<id>                                 -> JPEG (id tahmin edilemez, arkadaşın listesinde görünür)
//  /social/display-name    { name }                        -> { ok, name }   (görünen ad: benzersiz olmak zorunda değil)
//  /social/rename          { username }                    -> { ok, username }   (kimliği değiştirir; uygulama kullanmıyor)
//  /social/offline         {}                              -> { ok }       (uygulama kapanırken)
//  /social/friends         {}                              -> { friends, incoming, outgoing }
//  /social/friend-request  { username }                    -> { ok }
//  /social/friend-respond  { username, accept }            -> { ok }
//  /social/friend-remove   { username }                    -> { ok }
//  /social/share           { to: [username], name, songs } -> { ok, sent }
//  /social/inbox           {}                              -> { items }
//  /social/inbox-dismiss   { id }                          -> { ok }
//  /social/taste-set       { artists:[{n, w}] }            -> { ok }       (Blend için en çok dinlenen sanatçılar)
//  /social/blend           { username }                    -> { me, friend }  (yalnızca arkadaşlar; iki tarafın zevki)
//  /social/library-get     {}                              -> { exists, updatedAt, favs, playlists }   (hesaba bağlı beğeniler + listeler)
//  /social/library-set     { favs, playlists }             -> { ok, updatedAt }
//  /social/user-lists      { username }                    -> { lists:[{id,name,songs,likes,liked}] }   (bir kullanıcının HERKESE AÇIK listeleri)
//  /social/public-lists    {}                              -> { lists:[{owner,ownerName,avatar,id,name,count,cover,likes,liked}] }   (keşfet: en çok beğenilenler)
//  /social/public-list     { username, id }                -> { list:{id,name,songs,likes,liked} }   (herkese açık TEK liste, şarkılarıyla)
//  /social/list-like       { username, id, like }          -> { ok, likes }   (herkese açık bir listeyi beğen / beğenmekten vazgeç)
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
const AVATAR_MAX = 180 * 1024;     // profil fotoğrafı en fazla 64 KB (uygulama 256x256 JPEG yollar)
const MAX_SONGS = 100;
const MAX_INBOX = 20;
const JOIN_LIMIT = 5;             // IP başına 10 dakikada en fazla 5 hesap

// users: username(lowercase) -> { username, tokenHash, lastSeen, friends:[lc], incoming:[lc], outgoing:[lc], inbox:[...] }
// lastSeen yalnızca bellekte tutulur (kaydedilmez): böylece her sinyal veritabanına yazı yapmaz.
const users = {};
// "seenAt" (son görülme) KALICIDIR: sunucu yeniden başlasa da arkadaşların "Son görülme" bilgisi kaybolmaz.
const MEMORY_ONLY = new Set(['lastSeen', 'playing', 'renamedAt', 'avatarAt', 'libSetAt']);   // bellekte kalır, veritabanına yazılmaz
const SEEN_PERSIST_MS = 2 * 60 * 1000;   // çevrim içiyken son görülme en fazla 2 dakikada bir veritabanına yazılır
const ser = (u) => JSON.stringify(u, (k, v) => (MEMORY_ONLY.has(k) ? undefined : v));
const removed = new Set();   // adı değişen kullanıcıların eski anahtarları
const tokenIndex = new Map();   // tokenHash -> kullanıcı (her istekte tüm kullanıcıları taramamak için)
const MAX_TOKENS = 5;           // aynı hesapla en fazla 5 cihaz oturumu

function normalizeUser(u) {
  for (const f of ['friends', 'incoming', 'outgoing', 'inbox']) if (!Array.isArray(u[f])) u[f] = [];
  if (!Array.isArray(u.tokenHashes)) u.tokenHashes = [];
  if (u.tokenHash && !u.tokenHashes.includes(u.tokenHash)) u.tokenHashes.push(u.tokenHash);   // eski kayıt biçimi
  delete u.tokenHash;
  if (!Array.isArray(u.taste)) u.taste = [];
  if (!u.displayName) u.displayName = u.username;
  if (typeof u.seenAt !== 'number') u.seenAt = 0;
  u.lastSeen = 0;
  return u;
}
function indexUser(u) { for (const h of u.tokenHashes) tokenIndex.set(h, u); }

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
        try { const u = normalizeUser(JSON.parse(v)); users[String(u.username).toLowerCase()] = u; indexUser(u); } catch (e) { /* bozuk kayıt */ }
      });
    }
  } else {
    try {
      const all = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const [k, u] of Object.entries(all)) { try { users[k] = normalizeUser(u); indexUser(u); } catch (e) { /* bozuk kayıt */ } }
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

// ---- Beğeniler + çalma listeleri: Redis'te "l:<libId>" (JSON), Redis yoksa dosyada. Kullanıcı kaydını şişirmemek için ayrı tutulur. ----
const LIB_DIR = process.env.LIB_DIR || './social-libs';
const LIB_MAX_BYTES = 700 * 1024;   // Upstash isteği 1 MB sınırının altında kalsın
async function libGet(id) {
  if (useRedis) {
    const [r] = await redis([['GET', 'l:' + id]]);
    return r.result ? JSON.parse(r.result) : null;
  }
  try { return JSON.parse(await fs.promises.readFile(path.join(LIB_DIR, id + '.json'), 'utf8')); } catch (e) { return null; }
}
async function libSet(id, obj) {
  const text = JSON.stringify(obj);
  if (useRedis) { await redis([['SET', 'l:' + id, text]]); return; }
  await fs.promises.mkdir(LIB_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(LIB_DIR, id + '.json'), text);
}

// Şarkı: { t: başlık, a: sanatçı, u: adres, i: kapak }. Cihazdaki yüklemeler (local://) sunucuya gitmez.
function cleanLibSong(s) {
  if (!s) return null;
  const u = typeof s.u === 'string' && s.u ? s.u : (typeof s.url === 'string' ? s.url : '');
  if (!u || u.length > 300 || u.startsWith('local://')) return null;
  const t = String(s.t || s.title || '').slice(0, 150);
  const a = String(s.a || s.artist || '').slice(0, 100);
  const i = s.i ? String(s.i).slice(0, 300) : (s.thumb ? String(s.thumb).slice(0, 300) : '');
  return { t, a, u, i };
}
function cleanLibSongs(arr, max) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const s = cleanLibSong(raw);
    if (!s || seen.has(s.u)) continue;
    seen.add(s.u);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
// Liste kapağı: kapak resmi olan ilk şarkının resmi (ilk şarkının resmi yoksa sıradakine bakılır)
function coverOf(songs) {
  const s = (songs || []).find((x) => x && x.i);
  return s ? s.i : null;
}
function cleanLibrary(body) {
  const favs = cleanLibSongs(body.favs, 3000);
  const playlists = [];
  const ids = new Set();
  for (const p of (Array.isArray(body.playlists) ? body.playlists.slice(0, 100) : [])) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 40 || ids.has(p.id)) continue;
    ids.add(p.id);
    const isPub = p.pub === true || p.pub === 'true';
    playlists.push({ id: p.id, name: String(p.name || 'Liste').slice(0, 40), pub: isPub, cover: typeof p.cover === 'string' ? p.cover.slice(0, 500) : null, songs: cleanLibSongs(p.songs, 1000) });
  }
  return { favs, playlists };
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

// Sunucu kapanırken (Render yeniden başlatma) bekleyen değişiklikleri hemen yazar
async function flushNow() { if (timer) { clearTimeout(timer); timer = null; } await flush(); }

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const lc = (s) => String(s || '').trim().replace(/^@+/, '').toLowerCase();
const validName = (s) => /^[a-zA-Z0-9_.]{3,20}$/.test(s);
const joinHits = new Map();

function authUser(req) {
  const h = String(req.headers['authorization'] || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  return tokenIndex.get(sha(token)) || null;
}

// Hesap (e-posta) girişi için: kullanıcı oluşturur / mevcut kullanıcıya yeni cihaz anahtarı verir.
function joinAllowed(ip) {
  const now = Date.now();
  let h = joinHits.get(ip);
  if (!h || h.reset < now) { h = { count: 0, reset: now + 10 * 60 * 1000 }; joinHits.set(ip, h); }
  return ++h.count <= JOIN_LIMIT;
}
function createUser(name, display) {
  const token = crypto.randomBytes(24).toString('hex');
  const u = { username: name, displayName: String(display || name).trim().slice(0, 30) || name, tokenHashes: [sha(token)], lastSeen: Date.now(), friends: [], incoming: [], outgoing: [], inbox: [], taste: [] };
  users[lc(name)] = u;
  indexUser(u);
  touch(u);
  return { token, username: name };
}
function issueToken(username) {
  const u = users[lc(username)];
  if (!u) return null;
  const token = crypto.randomBytes(24).toString('hex');
  u.tokenHashes.push(sha(token));
  while (u.tokenHashes.length > MAX_TOKENS) tokenIndex.delete(u.tokenHashes.shift());
  indexUser(u);
  touch(u);
  return { token, username: u.username };
}
const userExists = (name) => Boolean(users[lc(name)]);

// Benzersiz kimlik (arkadaş ekleme için): e-postanın baş kısmı + rastgele sayı, örn. "emir_4821". Kullanıcı bulmak zorunda kalmaz.
function generateId(seed) {
  if (!seed) {   // e-postadan bağımsız, rastgele kimlik: sd_a1b2c3
    for (let i = 0; i < 50; i++) { const id = 'sd_' + crypto.randomBytes(3).toString('hex'); if (!users[lc(id)]) return id; }
    return 'sd_' + crypto.randomBytes(6).toString('hex');
  }
  let base = String(seed || '').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 12);
  if (base.length < 3) base = (base + 'user').slice(0, 12);
  for (let i = 0; i < 50; i++) {
    const id = base + '_' + crypto.randomInt(1000, 10000);
    if (!users[lc(id)]) return id;
  }
  return base + '_' + crypto.randomBytes(4).toString('hex');
}
function setDisplayName(username, name) {
  const u = users[lc(username)];
  const n = String(name || '').trim().slice(0, 30);
  if (!u || !n) return false;
  u.displayName = n;
  touch(u);
  return true;
}

// Sunucu içi yeniden adlandırma (hesap kimliği değişince arkadaşlıklar korunur). Başarılıysa true.
function renameUser(oldName, newName) {
  const oldKey = lc(oldName), newKey = lc(newName);
  const me = users[oldKey];
  if (!me || !validName(newName) || users[newKey]) return false;
  delete users[oldKey];
  users[newKey] = me;
  removed.add(oldKey);
  const others = new Set([...me.friends, ...me.incoming, ...me.outgoing]);
  const changed = [];
  for (const k of others) {
    const o = users[k];
    if (!o) continue;
    for (const f of ['friends', 'incoming', 'outgoing']) o[f] = o[f].map((x) => (x === oldKey ? newKey : x));
    // beğeniler: bu kullanıcının başkalarının listelerine verdiği beğeniler
    changed.push(o);
  }
  for (const u of Object.values(users)) {
    if (!u.likes) continue;
    for (const id of Object.keys(u.likes)) {
      if (u.likes[id].includes(oldKey)) { u.likes[id] = u.likes[id].map((x) => (x === oldKey ? newKey : x)); changed.push(u); }
    }
  }
  me.username = newName;
  touch(me, ...changed);
  return true;
}

const isOnline = (u) => u.lastSeen > 0 && Date.now() - u.lastSeen < ONLINE_MS;
const dname = (u) => u.displayName || u.username;
const seenTime = (u) => Math.max(u.lastSeen || 0, u.seenAt || 0);
const view = (u) => {
  const seen = seenTime(u);
  // seenAgo: "ne kadar önce" (ms). Telefonun saati yanlış olsa bile son görülme doğru gösterilir. -1: hiç görülmedi.
  const v = {
    username: u.username,
    name: dname(u),
    online: isOnline(u),
    lastSeen: seen,
    seenAgo: seen > 0 ? Math.max(0, Date.now() - seen) : -1,
    avatar: u.avatar || null,
    profileSong: u.profileSong || null,
    status: (u.status && Date.now() - (u.status.createdAt || 0) < 24 * 3600 * 1000) ? u.status : null
  };
  if (v.online && u.playing) v.listening = u.playing;   // yalnızca çevrim içiyken gösterilir
  return v;
};

function snapshot(me) {
  const list = (arr) => arr.map((n) => users[n]).filter(Boolean);
  return {
    me: {
      username: me.username,
      name: dname(me),
      avatar: me.avatar || null,
      profileSong: me.profileSong || null,
      status: (me.status && Date.now() - (me.status.createdAt || 0) < 24 * 3600 * 1000) ? me.status : null
    },
    friends: list(me.friends).map(view),
    incoming: list(me.incoming).map((u) => ({ username: u.username, name: dname(u), avatar: u.avatar || null })),
    outgoing: list(me.outgoing).map((u) => ({ username: u.username, name: dname(u), avatar: u.avatar || null })),
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
    if (!s) continue;
    const url = typeof s.url === 'string' && s.url ? s.url : (typeof s.u === 'string' ? s.u : '');
    if (!url || url.startsWith('local://') || url.length > 300 || seen.has(url)) continue;
    seen.add(url);
    const title = String(s.title || s.t || '').slice(0, 150);
    const artist = String(s.artist || s.a || '').slice(0, 100);
    const thumb = s.thumb ? String(s.thumb).slice(0, 300) : (s.i ? String(s.i).slice(0, 300) : null);
    out.push({
      title,
      artist,
      url,
      thumb,
      t: title,
      a: artist,
      u: url,
      i: thumb || ''
    });
  }
  return out;
}

// handle: yönetildiyse true döner. reply(status, obj) sunucudan gelir.
async function deleteUser(username) {
  const k = lc(username);
  const u = users[k];
  if (!u) return false;
  const affected = [];
  for (const f of u.friends || []) {
    const friend = users[f];
    if (friend) { friend.friends = without(friend.friends, k); affected.push(friend); }
  }
  for (const f of u.incoming || []) {
    const friend = users[f];
    if (friend) { friend.outgoing = without(friend.outgoing, k); affected.push(friend); }
  }
  for (const f of u.outgoing || []) {
    const friend = users[f];
    if (friend) { friend.incoming = without(friend.incoming, k); affected.push(friend); }
  }
  if (affected.length) touch(...affected);

  for (const th of u.tokenHashes || []) tokenIndex.delete(th);

  if (u.avatar) {
    const id = u.avatar.split('/social/avatar/')[1];
    if (id) { avatarCache.delete(id); blobDel(id).catch(() => {}); }
  }

  if (u.libId) {
    try {
      if (useRedis) await redis([['DEL', 'l:' + u.libId]]);
      else await fs.promises.unlink(path.join(LIB_DIR, u.libId + '.json')).catch(() => {});
    } catch (e) {}
  }

  delete users[k];
  removed.add(k);
  await flushNow();
  return true;
}

async function handle(req, res, path, body, ip, reply) {
  if (!path.startsWith('/social/')) return false;
  if (!(await ensureLoaded())) { reply(res, 503, { error: 'Sunucu veritabanına ulaşamıyor. Biraz sonra tekrar dene.' }); return true; }

  if (path === '/social/join') {
    if (!joinAllowed(ip)) { reply(res, 429, { error: 'Çok fazla deneme. Biraz sonra tekrar dene.' }); return true; }
    const name = String(body.username || '').trim().replace(/^@+/, '');
    if (!validName(name)) { reply(res, 400, { error: 'Kullanıcı adı 3-20 karakter olmalı (harf, rakam, _ ve .).' }); return true; }
    if (users[lc(name)]) { reply(res, 409, { error: 'Bu kullanıcı adı alınmış.' }); return true; }
    reply(res, 200, createUser(name));
    return true;
  }

  const me = authUser(req);
  if (!me) { reply(res, 401, { error: 'Oturum geçersiz. Sosyal hesabını yeniden oluştur.' }); return true; }

  switch (path) {
    case '/social/heartbeat':
      {
        const wasOnline = isOnline(me);
        me.lastSeen = Date.now();
        // İlk sinyalde (yeni açıldı) ve sonra 2 dakikada bir kalıcı yaz: uygulama aniden kapansa da son görülme kaybolmaz
        if (!wasOnline || me.lastSeen - (me.seenAt || 0) > SEEN_PERSIST_MS) { me.seenAt = me.lastSeen; touch(me); }
      }
      me.playing = cleanPlaying(body.playing);   // gönderilmezse "dinlemiyor" sayılır
      reply(res, 200, Object.assign({ ok: true }, snapshot(me)));
      return true;

    case '/social/offline':
      me.lastSeen = Date.now() - ONLINE_MS;   // çevrim dışı say ama son görülme zamanı kalsın
      me.seenAt = Date.now();                 // ... ve kalıcı olarak kaydedilsin
      me.playing = null;
      touch(me);
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
          from: dname(me),
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

        case '/social/profile-song-set': {
      if (!body.song || typeof body.song !== 'object') { reply(res, 400, { error: 'Geçersiz şarkı.' }); return true; }
      const s = body.song;
      me.profileSong = {
        title: String(s.title || s.t || '').slice(0, 150),
        artist: String(s.artist || s.a || '').slice(0, 100),
        url: String(s.url || s.u || '').slice(0, 300),
        thumb: s.thumb || s.i ? String(s.thumb || s.i).slice(0, 300) : null
      };
      touch(me);
      reply(res, 200, { ok: true, profileSong: me.profileSong });
      return true;
    }

    case '/social/profile-song-clear': {
      me.profileSong = null;
      touch(me);
      reply(res, 200, { ok: true });
      return true;
    }

    case '/social/status-set': {
      const text = String(body.text || '').trim().slice(0, 150);
      let s = null;
      if (body.song && typeof body.song === 'object') {
        const bs = body.song;
        s = {
          title: String(bs.title || bs.t || '').slice(0, 150),
          artist: String(bs.artist || bs.a || '').slice(0, 100),
          url: String(bs.url || bs.u || '').slice(0, 300),
          thumb: bs.thumb || bs.i ? String(bs.thumb || bs.i).slice(0, 300) : null
        };
      }
      me.status = { text, song: s, createdAt: Date.now() };
      touch(me);
      reply(res, 200, { ok: true, status: me.status });
      return true;
    }

    case '/social/status-clear': {
      me.status = null;
      touch(me);
      reply(res, 200, { ok: true });
      return true;
    }

    case '/social/display-name': {
      const n = String(body.name || '').trim().slice(0, 30);
      if (!n) { reply(res, 400, { error: 'Ad boş olamaz.' }); return true; }
      me.displayName = n;
      touch(me);
      reply(res, 200, { ok: true, name: n });
      return true;
    }

    case '/social/rename': {
      const name = String(body.username || '').trim().replace(/^@+/, '');
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
      if (b64.length > 280000) { reply(res, 400, { error: 'Fotoğraf çok büyük.' }); return true; }
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

    case '/social/cover-set': {
      const b64 = String(body.image || '');
      if (b64.length > 280000) { reply(res, 400, { error: 'Fotoğraf çok büyük.' }); return true; }
      const buf = Buffer.from(b64, 'base64');
      const jpeg = buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      if (!jpeg || buf.length > AVATAR_MAX) { reply(res, 400, { error: 'Geçersiz fotoğraf.' }); return true; }
      const id = crypto.randomBytes(8).toString('hex');
      try { await blobSet(id, buf); } catch (e) { console.error('Kapak kaydı:', e.message); reply(res, 503, { error: 'Fotoğraf kaydedilemedi. Tekrar dene.' }); return true; }
      cachePut(id, buf);
      reply(res, 200, { ok: true, id, url: `/social/avatar/${id}` });
      return true;
    }

    case '/social/taste-set': {
      const arr = Array.isArray(body.artists) ? body.artists.slice(0, 30) : [];
      const out = [];
      for (const a of arr) {
        if (!a || typeof a.n !== 'string') continue;
        const n = a.n.trim().slice(0, 80);
        if (!n) continue;
        out.push({ n, w: Math.max(1, Math.min(100000, Math.round(Number(a.w) || 1))) });
      }
      me.taste = out;
      touch(me);
      reply(res, 200, { ok: true });
      return true;
    }

    case '/social/blend': {
      const t = users[lc(body.username)];
      if (!t || !me.friends.includes(lc(t.username))) { reply(res, 404, { error: 'Bu kişi arkadaş listende değil.' }); return true; }
      reply(res, 200, {
        me: { username: me.username, name: dname(me), avatar: me.avatar || null, artists: me.taste || [] },
        friend: { username: t.username, name: dname(t), avatar: t.avatar || null, artists: t.taste || [] }
      });
      return true;
    }

    case '/social/library-get': {
      if (!me.libId) { reply(res, 200, { exists: false, updatedAt: 0, favs: [], playlists: [] }); return true; }
      let lib;
      try { lib = await libGet(me.libId); } catch (e) { console.error('Kitaplık okuma:', e.message); reply(res, 503, { error: 'Kitaplık okunamadı. Biraz sonra tekrar dene.' }); return true; }
      if (!lib) { reply(res, 200, { exists: false, updatedAt: 0, favs: [], playlists: [] }); return true; }
      reply(res, 200, { exists: true, updatedAt: me.libAt || 0, favs: lib.favs || [], playlists: lib.playlists || [] });
      return true;
    }

    case '/social/library-set': {
      if (Date.now() - (me.libSetAt || 0) < 1000) { reply(res, 429, { error: 'Çok sık kaydediliyor. Biraz bekle.' }); return true; }
      const lib = cleanLibrary(body);
      if (Buffer.byteLength(JSON.stringify(lib)) > LIB_MAX_BYTES) { reply(res, 413, { error: 'Kitaplık çok büyük, kaydedilemedi.' }); return true; }
      if (!me.libId) me.libId = crypto.randomBytes(12).toString('hex');
      try { await libSet(me.libId, lib); } catch (e) { console.error('Kitaplık kaydı:', e.message); reply(res, 503, { error: 'Kitaplık kaydedilemedi. Tekrar dene.' }); return true; }
      me.pubLists = lib.playlists.filter((p) => (p.pub === true || p.pub === 'true'))
        .map((p) => ({ id: p.id, name: p.name, count: (p.songs || []).length, cover: p.cover || coverOf(p.songs) }));
      me.libSetAt = Date.now();
      me.libAt = Math.max(Date.now(), (me.libAt || 0) + 1);
      touch(me);
      reply(res, 200, { ok: true, updatedAt: me.libAt });
      return true;
    }

    case '/social/user-lists': {
      const t = users[lc(body.username)];
      if (!t) { reply(res, 404, { error: 'Kullanıcı bulunamadı.' }); return true; }
      if (!t.libId) { reply(res, 200, { lists: [] }); return true; }
      let lib;
      try { lib = await libGet(t.libId); } catch (e) { console.error('Kullanıcı listeleri:', e.message); reply(res, 503, { error: 'Listeler okunamadı. Biraz sonra tekrar dene.' }); return true; }
      const mine = me ? lc(me.username) : '';
      const lists = ((lib && lib.playlists) || []).filter((p) => p && (p.pub === true || p.pub === 'true'))
        .slice(0, 50).map((p) => {
          const songs = Array.isArray(p.songs) ? p.songs : [];
          const likers = (t.likes && t.likes[p.id]) || [];
          return { id: p.id, name: p.name, cover: p.cover || coverOf(songs), songs: songs.slice(0, 300), likes: likers.length, liked: likers.includes(mine) };
        });
      reply(res, 200, { lists });
      return true;
    }

    case '/social/public-lists': {
      const mine = me ? lc(me.username) : '';
      const all = [];
      for (const u of Object.values(users)) {
        if (!Array.isArray(u.pubLists)) continue;
        for (const p of u.pubLists) {
          const likers = (u.likes && u.likes[p.id]) || [];
          all.push({ owner: u.username, ownerName: dname(u), avatar: u.avatar || null, id: p.id, name: p.name, count: p.count, cover: p.cover,
            likes: likers.length, liked: likers.includes(mine) });
        }
      }
      all.sort((a, b) => b.likes - a.likes || b.count - a.count);
      reply(res, 200, { lists: all.slice(0, 40) });
      return true;
    }

    case '/social/public-list': {
      const t = users[lc(body.username)];
      const id = String(body.id || '');
      if (!t || !t.libId || !Array.isArray(t.pubLists) || !t.pubLists.some((p) => p.id === id)) { reply(res, 404, { error: 'Liste herkese açık değil veya silinmiş.' }); return true; }
      let lib;
      try { lib = await libGet(t.libId); } catch (e) { console.error('Herkese açık liste:', e.message); reply(res, 503, { error: 'Liste okunamadı. Biraz sonra tekrar dene.' }); return true; }
      const p = ((lib && lib.playlists) || []).find((x) => x && x.id === id && (x.pub === true || x.pub === 'true') && Array.isArray(x.songs));
      if (!p) { reply(res, 404, { error: 'Liste herkese açık değil veya silinmiş.' }); return true; }
      const songs = Array.isArray(p.songs) ? p.songs : [];
      const likers = (t.likes && t.likes[id]) || [];
      reply(res, 200, { list: { id: p.id, name: p.name, cover: p.cover || coverOf(songs), songs: songs.slice(0, 300), likes: likers.length, liked: likers.includes(me ? lc(me.username) : '') } });
      return true;
    }

    case '/social/list-like': {
      const t = users[lc(body.username)];
      const id = String(body.id || '');
      if (!t || !Array.isArray(t.pubLists) || !t.pubLists.some((p) => p.id === id)) { reply(res, 404, { error: 'Liste herkese açık değil.' }); return true; }
      if (!t.likes || typeof t.likes !== 'object') t.likes = {};
      const set = new Set(t.likes[id] || []);
      if (body.like === false) set.delete(lc(me.username)); else set.add(lc(me.username));
      t.likes[id] = [...set].slice(0, 5000);
      touch(t);
      reply(res, 200, { ok: true, likes: set.size });
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

    case '/social/delete-account':
      await deleteUser(me.username);
      reply(res, 200, { ok: true });
      return true;

    default:
      reply(res, 404, { error: 'Bulunamadı' });
      return true;
  }
}

if (!useRedis) console.warn('UYARI: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN yok. Veriler dosyaya yazılıyor; Render ücretsiz pakette sunucu yeniden başlayınca TÜM hesaplar ve arkadaşlıklar silinir.');

module.exports = {
  handle, serveAvatar, ensureLoaded, flushNow,
  persistent: useRedis, redis, useRedis,
  createUser, issueToken, userExists, generateId, renameUser, setDisplayName, joinAllowed, validName, lc, sha, deleteUser
};
