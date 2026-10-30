# Sounddeep sunucusu

Tek sunucu üç iş yapar: **hesaplar** (e-posta + şifre), **e-posta kodu** ve **sosyal özellikler**
(arkadaşlar, profil fotoğrafı, liste paylaşımı, Blend uyum oranı).

Dosyalar: `server.js` (yönlendirme), `accounts.js` (hesaplar), `social.js` (arkadaşlar/Blend), `mail.js` (e-posta gönderimi).

## 1) Render'da yayınla
1. Bu `backend` klasörünü GitHub'a koy (repoda `backend/` olarak kalır).
2. Render: **New > Web Service**, repoyu bağla. Root Directory: `backend`, Build: `npm install`, Start: `npm start`.

## 2) ZORUNLU: Upstash Redis (hesapların silinmemesi için)
Render ücretsiz pakette disk kalıcı değildir; sunucu uyuyup uyandığında veya yeniden yayınlandığında dosyalar silinir.
**Upstash olmadan tüm hesaplar ve arkadaşlıklar her seferinde sıfırlanır.**
1. https://upstash.com > ücretsiz hesap > **Create Database** (Redis), sana yakın bir bölge seç.
2. Veritabanı sayfasında **REST API** bölümünden `UPSTASH_REDIS_REST_URL` ve `UPSTASH_REDIS_REST_TOKEN` değerlerini kopyala.
3. Render > servis > **Environment** bölümüne bu iki değişkeni aynı adlarla ekle. Servis yeniden başlar.

Kontrol: sunucu adresini tarayıcıda aç (`https://...onrender.com/`). `"persistent":true` görmelisin.
`false` ise Upstash değişkenleri eksiktir.

## 3) E-posta kodu (önerilen: Brevo)
Hesap oluştururken ve şifre sıfırlarken kod e-postayla gider. Render ücretsiz pakette SMTP portları kapalı olduğundan Brevo (HTTPS) önerilir:
1. https://www.brevo.com ücretsiz hesap aç, **SMTP & API > API Keys** bölümünden bir anahtar oluştur, bir gönderici adresi doğrula.
2. Render Environment: `BREVO_API_KEY` = anahtar, `MAIL_FROM` = doğruladığın gönderici adresi.

Alternatif (Gmail uygulama şifresi): `SMTP_USER` ve `SMTP_PASS` (`nodemailer` gerekir; `npm install` kurar).
Deneme için `MAIL_MODE=console` yazarsan kodlar e-posta yerine sunucu loguna yazılır.

Adresin `mail` değeri `true` görünüyorsa e-posta hazırdır. **E-posta ayarlı değilse** uygulama, kodu kendi EmailJS ayarıyla
gönderip doğrular (`EPOSTA_KURULUM.md`); bu yol daha az güvenlidir (başkası, sahibi kaydolmadan o e-postayı alabilir).
Brevo veya SMTP ayarlandığında doğrulama sunucuda yapılır.

## 4) Uygulamaya adresi yaz
`app/src/main/java/com/example/newmusic/Social.kt` içinde:
```kotlin
const val SOCIAL_API_URL = "https://new-music-cpzw.onrender.com"
```
Hesaplar da aynı adresi kullanır.

## Nasıl çalışır
- **Hesap:** e-posta + şifre sunucuda saklanır (şifre `scrypt` ile). Uygulamayı silip kursan bile aynı bilgilerle girersin;
  arkadaş kullanıcı adın ve arkadaşların da otomatik geri gelir.
- **Beğeniler ve listeler:** hesaba kaydedilir (`/social/library-get`, `/social/library-set`). Uygulama her değişiklikten 2 sn sonra yedekler;
  uygulamayı silip kursan bile giriş yapınca beğendiklerin ve çalma listelerin geri gelir. Cihazdan yüklenen şarkılar (`local://`) sunucuya gitmez.
  Kitaplık Upstash'ta `l:<id>` anahtarında saklanır (en fazla ~700 KB: yaklaşık 2000-3000 şarkı). Upstash yoksa bu da her yeniden başlatmada silinir.
- **Arkadaş kimliği:** hesap oluşturulunca e-postadan otomatik üretilir (örn. `emir_4821`), kullanıcı isim bulmak zorunda kalmaz.
  Arkadaşlar bu kimlikle eklenir. **Görünen ad** ise istenen her ad olabilir, benzersiz olmak zorunda değildir ve istediğinde değişir.
- **Blend:** uygulama en çok dinlediğin sanatçıları sunucuya yollar; yalnızca arkadaşların görür. Arkadaşına dokununca
  iki tarafın sanatçı dağılımlarının kesişimine göre uyum yüzdesi hesaplanır.
- **Hata mesajları:** artık gerçek sebep gösterilir. Sunucu içinde hata olursa uygulamaya "Sunucu hatası" döner,
  sebep Render logunda yazar.
- Çevrim içi/dışı bilgisi bellekte tutulur; sunucu yeniden başlayınca herkes birkaç saniye "çevrim dışı" görünür.
- Render ücretsiz sunucusu uykudan 30-60 sn'de uyanır; uygulama açılınca sunucuyu uyandırır ve isteklerde uzun bekler.

## Güvenlik notları
- Kod 10 dakika geçerli, 5 yanlış denemeden sonra iptal olur; aynı adrese 30 sn'de bir kod gider.
- Aynı e-postaya 15 dakikada en fazla 10 yanlış şifre denenebilir; IP başına istek sınırı vardır.
- Şifre sıfırlanınca eski oturumlar kapanır. Bir hesapla en fazla 5 cihaz oturumu açık kalır.
- Profil fotoğrafları (256x256 JPEG, en fazla 64 KB) Upstash'ta saklanır.
