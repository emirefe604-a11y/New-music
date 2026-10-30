// Sounddeep - sunucuda saklanan hesaplar (e-posta + şifre)
// Hesaplar artık telefonda değil sunucuda durur: uygulama silinip yeniden kurulsa bile aynı e-posta ve şifreyle giriş yapılır.
// Veriler sosyal özelliklerle aynı yerde saklanır (Upstash Redis varsa orada, yoksa dosyada).
//
//  /auth/exists       { email }                              -> { exists }
//  /auth/send-code    { email, purpose: signup|reset }       -> { ok }   (503 + mailDisabled: sunucuda e-posta ayarlı değil)
//  /auth/verify       { email, code }                        -> { ok }   (kodu doğrular; 15 dk içinde register/reset yapılabilir)
//  /auth/register     { email, password, name }              -> { ok, email, name, session, social }
//  /auth/login        { email, password }                    -> { ok, email, name, session, social }
//  /auth/reset        { email, password }                    -> { ok, email, name, session, social }
//  /auth/profile      { session, name }                      -> { ok }
//  /auth/social-join  { session }                            -> { token, username }   (arkadaş kimliği yoksa üretir)
//  /auth/logout       { session }                            -> { ok }
//
// "social" = { username, token } : giriş yapılınca arkadaş hesabı da yeni cihaza otomatik gelir.
const crypto = require('crypto');
const fs = require('fs');
const mail = require('./mail');
const social = require('./social');

const ACC_FILE = process.env.ACCOUNTS_FILE || './accounts-data.json';
const CODE_TTL_MS = 10 * 60 * 1000;      // kod 10 dakika geçerli
const VERIFIED_TTL_MS = 15 * 60 * 1000;  // doğrulanan e-posta 15 dakika içinde şifre belirleyebilir
const RESEND_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SESSIONS = 5;
const IP_LIMIT = 40;                     // IP başına 10 dakikada en fazla 40 /auth isteği
const LOGIN_FAILS = 10;                  // aynı e-postaya 15 dakikada en fazla 10 yanlış şifre

const accounts = {};                     // email -> { email, salt, hash, name, social, sessions:[sha], createdAt }
const sessionIndex = new Map();          // sessionHash -> hesap
const codes = new Map();                 // email -> { hash, expires, attempts, sentAt, purpose, verified }
const hits = new Map();                  // ip -> { count, reset }
const fails = new Map();                 // email -> { count, reset }

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const normEmail = (s) => String(s || '').trim().toLowerCase();

const scrypt = (pw, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (e, key) => (e ? reject(e) : resolve(key.toString('hex')))));

// ---------------------------------------------------------------- depolama

function indexAccount(a) {
  if (!Array.isArray(a.sessions)) a.sessions = [];
  for (const h of a.sessions) sessionIndex.set(h, a);
}

async function loadAll() {
  if (social.useRedis) {
    const [m] = await social.redis([['SMEMBERS', 'accounts']]);
    const emails = m.result || [];
    for (let i = 0; i < emails.length; i += 100) {
      const chunk = emails.slice(i, i + 100);
      const [res] = await social.redis([['MGET', ...chunk.map((e) => 'acc:' + e)]]);
      (res.result || []).forEach((v) => {
        if (!v) return;
        try { const a = JSON.parse(v); accounts[a.email] = a; indexAccount(a); } catch (e) { /* bozuk kayıt */ }
      });
    }
  } else {
    try {
      const all = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'));
      for (const [k, a] of Object.entries(all)) { accounts[k] = a; indexAccount(a); }
    } catch (e) { /* ilk çalışma */ }
  }
}

let loaded = false, loadPromise = null;
async function ensureLoaded() {
  if (loaded) return true;
  try { await (loadPromise = loadPromise || loadAll()); loaded = true; return true; }
  catch (e) { loadPromise = null; console.error('Hesaplar yüklenemedi:', e.message); return false; }
}

let writeChain = Promise.resolve();
async function persist(acc) {
  if (social.useRedis) {
    await social.redis([['SET', 'acc:' + acc.email, JSON.stringify(acc)], ['SADD', 'accounts', acc.email]]);
    return;
  }
  writeChain = writeChain.catch(() => {}).then(() => fs.promises.writeFile(ACC_FILE, JSON.stringify(accounts)));
  await writeChain;
}

// ---------------------------------------------------------------- yardımcılar

function newSession(acc) {
  const session = crypto.randomBytes(24).toString('hex');
  acc.sessions.push(sha(session));
  while (acc.sessions.length > MAX_SESSIONS) sessionIndex.delete(acc.sessions.shift());
  indexAccount(acc);
  return session;
}

// Her hesabın bir arkadaş kimliği vardır; yoksa e-postadan otomatik üretilir (kullanıcı isim bulmak zorunda kalmaz).
function socialFor(acc) {
  if (acc.social && social.userExists(acc.social)) return social.issueToken(acc.social);   // { token, username }
  const made = social.createUser(social.generateId(acc.email.split('@')[0]), acc.name);
  acc.social = made.username;
  persist(acc).catch((e) => console.error('Kimlik kaydedilemedi:', e.message));
  return made;
}

function sessionResult(acc, session) {
  return { ok: true, email: acc.email, name: acc.name || '', session, social: socialFor(acc) };
}

function ipLimited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset < now) { h = { count: 0, reset: now + 10 * 60 * 1000 }; hits.set(ip, h); }
  return ++h.count > IP_LIMIT;
}

function verifiedFor(email, purpose, body) {
  const e = codes.get(email);
  if (e && e.verified && e.purpose === purpose && e.expires > Date.now()) return true;
  // Sunucuda e-posta ayarlı değilse uygulama kodu kendisi (EmailJS ile) doğrular. Daha az güvenlidir; kurulum için backend/README.md.
  return !mail.enabled && body.clientVerified === true;
}

function validPassword(p) { return typeof p === 'string' && p.length >= 6 && p.length <= 200; }
const cleanName = (n) => String(n || '').trim().slice(0, 30);

// ---------------------------------------------------------------- uç noktalar

async function handle(req, res, path, body, ip, reply) {
  if (!path.startsWith('/auth/')) return false;
  if (ipLimited(ip)) { reply(res, 429, { error: 'Çok fazla istek. Biraz sonra tekrar dene.' }); return true; }
  if (!(await ensureLoaded()) || !(await social.ensureLoaded())) {
    reply(res, 503, { error: 'Sunucu veritabanına ulaşamıyor. Biraz sonra tekrar dene.' });
    return true;
  }
  const email = normEmail(body.email);

  switch (path) {
    case '/auth/exists':
      if (!isEmail(email)) { reply(res, 400, { error: 'Geçerli bir e-posta adresi yaz.' }); return true; }
      reply(res, 200, { exists: Boolean(accounts[email]) });
      return true;

    case '/auth/send-code': {
      const purpose = body.purpose === 'reset' ? 'reset' : 'signup';
      if (!isEmail(email)) { reply(res, 400, { error: 'Geçerli bir e-posta adresi yaz.' }); return true; }
      const exists = Boolean(accounts[email]);
      if (purpose === 'signup' && exists) { reply(res, 409, { error: 'Bu e-postayla zaten hesap var. Giriş yap veya şifreni sıfırla.' }); return true; }
      if (purpose === 'reset' && !exists) { reply(res, 404, { error: 'Bu e-postayla kayıtlı hesap bulunamadı. Önce hesap oluştur.' }); return true; }
      if (!mail.enabled) { reply(res, 503, { error: 'Sunucuda e-posta gönderimi ayarlı değil.', mailDisabled: true }); return true; }
      const old = codes.get(email);
      if (old && Date.now() - old.sentAt < RESEND_MS) { reply(res, 429, { error: 'Lütfen yeni kod istemeden önce biraz bekle.' }); return true; }
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      try { await mail.sendCode(email, code, purpose); }
      catch (e) { console.error('Mail gönderilemedi:', e.message); reply(res, 502, { error: 'E-posta gönderilemedi. Daha sonra tekrar dene.' }); return true; }
      codes.set(email, { hash: sha(code), expires: Date.now() + CODE_TTL_MS, attempts: 0, sentAt: Date.now(), purpose, verified: false });
      reply(res, 200, { ok: true });
      return true;
    }

    case '/auth/verify': {
      const code = String(body.code || '').trim();
      const entry = codes.get(email);
      if (!entry || entry.expires < Date.now()) { reply(res, 400, { error: 'Kodun süresi dolmuş. Yeni kod iste.' }); return true; }
      if (entry.attempts >= MAX_ATTEMPTS) { codes.delete(email); reply(res, 429, { error: 'Çok fazla yanlış deneme. Yeni kod iste.' }); return true; }
      entry.attempts += 1;
      const a = Buffer.from(sha(code)), b = Buffer.from(entry.hash);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        entry.verified = true;
        entry.expires = Date.now() + VERIFIED_TTL_MS;
        reply(res, 200, { ok: true });
      } else {
        reply(res, 400, { error: 'Kod yanlış. Tekrar dene.' });
      }
      return true;
    }

    case '/auth/register': {
      if (!isEmail(email)) { reply(res, 400, { error: 'Geçerli bir e-posta adresi yaz.' }); return true; }
      if (accounts[email]) { reply(res, 409, { error: 'Bu e-postayla zaten hesap var. Giriş yap veya şifreni sıfırla.' }); return true; }
      if (!verifiedFor(email, 'signup', body)) { reply(res, 403, { error: 'E-posta doğrulaması bulunamadı veya süresi doldu. Yeni kod iste.' }); return true; }
      if (!validPassword(body.password)) { reply(res, 400, { error: 'Şifre en az 6 karakter olmalı.' }); return true; }
      const name = cleanName(body.name);
      if (!name) { reply(res, 400, { error: 'Adını yaz.' }); return true; }
      const salt = crypto.randomBytes(16).toString('hex');
      const acc = { email, salt, hash: await scrypt(body.password, salt), name, social: null, sessions: [], createdAt: Date.now() };
      const session = newSession(acc);
      accounts[email] = acc;
      try { await persist(acc); }
      catch (e) {
        delete accounts[email]; sessionIndex.delete(acc.sessions[0]);
        console.error('Hesap kaydedilemedi:', e.message);
        reply(res, 503, { error: 'Hesap kaydedilemedi. Tekrar dene.' });
        return true;
      }
      codes.delete(email);
      reply(res, 200, sessionResult(acc, session));
      return true;
    }

    case '/auth/login': {
      if (!isEmail(email)) { reply(res, 400, { error: 'Geçerli bir e-posta adresi yaz.' }); return true; }
      const now = Date.now();
      let f = fails.get(email);
      if (!f || f.reset < now) { f = { count: 0, reset: now + 15 * 60 * 1000 }; fails.set(email, f); }
      if (f.count >= LOGIN_FAILS) { reply(res, 429, { error: 'Çok fazla yanlış deneme. 15 dakika sonra tekrar dene veya şifreni sıfırla.' }); return true; }
      const acc = accounts[email];
      if (!acc) { reply(res, 404, { error: 'Bu e-postayla kayıtlı hesap bulunamadı. "Hesap oluştur" ile kaydol.' }); return true; }
      const given = typeof body.password === 'string' ? await scrypt(body.password, acc.salt) : '';
      const a = Buffer.from(given), b = Buffer.from(acc.hash);
      if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
        f.count += 1;
        reply(res, 401, { error: 'E-posta veya şifre yanlış.' });
        return true;
      }
      fails.delete(email);
      const session = newSession(acc);
      try { await persist(acc); } catch (e) { /* oturum belleğte kalır; sonraki girişte yeniden yazılır */ }
      reply(res, 200, sessionResult(acc, session));
      return true;
    }

    case '/auth/reset': {
      const acc = accounts[email];
      if (!acc) { reply(res, 404, { error: 'Bu e-postayla kayıtlı hesap bulunamadı.' }); return true; }
      if (!verifiedFor(email, 'reset', body)) { reply(res, 403, { error: 'E-posta doğrulaması bulunamadı veya süresi doldu. Yeni kod iste.' }); return true; }
      if (!validPassword(body.password)) { reply(res, 400, { error: 'Şifre en az 6 karakter olmalı.' }); return true; }
      acc.salt = crypto.randomBytes(16).toString('hex');
      acc.hash = await scrypt(body.password, acc.salt);
      for (const h of acc.sessions) sessionIndex.delete(h);   // eski oturumlar kapanır
      acc.sessions = [];
      const session = newSession(acc);
      try { await persist(acc); }
      catch (e) { console.error('Şifre kaydedilemedi:', e.message); reply(res, 503, { error: 'Şifre kaydedilemedi. Tekrar dene.' }); return true; }
      codes.delete(email);
      fails.delete(email);
      reply(res, 200, sessionResult(acc, session));
      return true;
    }

    case '/auth/logout': {
      const h = sha(String(body.session || ''));
      const acc = sessionIndex.get(h);
      if (acc) {
        acc.sessions = acc.sessions.filter((x) => x !== h);
        sessionIndex.delete(h);
        try { await persist(acc); } catch (e) { /* önemli değil */ }
      }
      reply(res, 200, { ok: true });
      return true;
    }
  }

  // ---- Oturum isteyen uç noktalar ----
  const acc = sessionIndex.get(sha(String(body.session || '')));
  if (!acc) { reply(res, 401, { error: 'Oturum süresi dolmuş. Yeniden giriş yap.' }); return true; }

  switch (path) {
    case '/auth/profile': {
      const name = cleanName(body.name);
      if (!name) { reply(res, 400, { error: 'Ad boş olamaz.' }); return true; }
      acc.name = name;
      if (acc.social) social.setDisplayName(acc.social, name);   // arkadaşlar yeni adı görür
      try { await persist(acc); } catch (e) { reply(res, 503, { error: 'Kaydedilemedi. Tekrar dene.' }); return true; }
      reply(res, 200, { ok: true });
      return true;
    }

    case '/auth/social-join': {
      // Eski istemciler için: kimlik artık otomatik üretilir, istenen kullanıcı adı yok sayılır
      reply(res, 200, socialFor(acc));
      return true;
    }

    default:
      reply(res, 404, { error: 'Bulunamadı' });
      return true;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  for (const [k, v] of fails) if (v.reset < now) fails.delete(k);
}, 60 * 1000).unref();

module.exports = { handle };
