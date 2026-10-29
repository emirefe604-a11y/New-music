// Sounddeep - sosyal özellikler: arkadaşlar, çevrim içi/dışı bilgisi, liste paylaşımı
// Tüm uç noktalar POST'tur. /social/join dışındakiler "Authorization: Bearer <token>" ister.
//
//  /social/join            { username }                    -> { token, username }
//  /social/heartbeat       {}                              -> { ok }       (uygulama açıkken ~30 sn'de bir)
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

const DATA_FILE = process.env.DATA_FILE || './social-data.json';
const ONLINE_MS = 75 * 1000;      // son sinyalden bu yana 75 sn geçmediyse "çevrim içi"
const MAX_SONGS = 200;
const MAX_INBOX = 50;
const JOIN_LIMIT = 5;             // IP başına 10 dakikada en fazla 5 hesap

// users: username(lowercase) -> { username, tokenHash, lastSeen, friends:[lc], incoming:[lc], outgoing:[lc], inbox:[...] }
let users = {};
try { users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { users = {}; }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE, JSON.stringify(users), (err) => { if (err) console.error('Kayıt hatası:', err.message); });
  }, 1000);
  saveTimer.unref();
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
const view = (u) => ({ username: u.username, online: isOnline(u), lastSeen: u.lastSeen || 0 });
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
    save();
    reply(res, 200, { token, username: name });
    return true;
  }

  const me = authUser(req);
  if (!me) { reply(res, 401, { error: 'Oturum geçersiz. Sosyal hesabını yeniden oluştur.' }); return true; }

  switch (path) {
    case '/social/heartbeat':
      me.lastSeen = Date.now();
      save();
      reply(res, 200, { ok: true });
      return true;

    case '/social/offline':
      me.lastSeen = Date.now() - ONLINE_MS;   // çevrim dışı say ama son görülme zamanı kalsın
      save();
      reply(res, 200, { ok: true });
      return true;

    case '/social/friends': {
      me.lastSeen = Date.now();
      const list = (arr) => arr.map((n) => users[n]).filter(Boolean);
      reply(res, 200, {
        friends: list(me.friends).map(view),
        incoming: list(me.incoming).map((u) => ({ username: u.username })),
        outgoing: list(me.outgoing).map((u) => ({ username: u.username })),
        inbox: me.inbox.length
      });
      return true;
    }

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
      save();
      reply(res, 200, { ok: true });
      return true;
    }

    case '/social/friend-respond': {
      const t = users[lc(body.username)];
      const a = lc(me.username), b = t ? lc(t.username) : '';
      if (!t || !me.incoming.includes(b)) { reply(res, 404, { error: 'İstek bulunamadı.' }); return true; }
      me.incoming = without(me.incoming, b); t.outgoing = without(t.outgoing, a);
      if (body.accept === true) { me.friends.push(b); t.friends.push(a); }
      save();
      reply(res, 200, { ok: true });
      return true;
    }

    case '/social/friend-remove': {
      const b = lc(body.username), a = lc(me.username);
      const t = users[b];
      me.friends = without(me.friends, b); me.outgoing = without(me.outgoing, b); me.incoming = without(me.incoming, b);
      if (t) { t.friends = without(t.friends, a); t.outgoing = without(t.outgoing, a); t.incoming = without(t.incoming, a); }
      save();
      reply(res, 200, { ok: true });
      return true;
    }

    case '/social/share': {
      const songs = cleanSongs(body.songs);
      if (songs.length === 0) { reply(res, 400, { error: 'Paylaşılacak şarkı yok. Cihazdan yüklenen şarkılar paylaşılamaz.' }); return true; }
      const targets = Array.isArray(body.to) ? body.to.slice(0, 20) : [];
      let sent = 0;
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
        sent++;
      }
      save();
      reply(res, 200, { ok: true, sent });
      return true;
    }

    case '/social/inbox':
      reply(res, 200, { items: me.inbox });
      return true;

    case '/social/inbox-dismiss':
      me.inbox = me.inbox.filter((i) => i.id !== body.id);
      save();
      reply(res, 200, { ok: true });
      return true;

    default:
      reply(res, 404, { error: 'Bulunamadı' });
      return true;
  }
}

module.exports = { handle };
