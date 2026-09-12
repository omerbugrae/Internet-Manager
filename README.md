# Internet Manager

Electron arayüzü ve Python transfer motoruyla geliştirilen ücretsiz indirme/yükleme yöneticisi.

## v1.0'ı çalıştırma

Python ortamını etkinleştirin:

```powershell
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Ardından Electron uygulamasını başlatın:

```powershell
npm start
```

Electron, geliştirme sırasında `venv\Scripts\python.exe` üzerinden Python motorunu otomatik başlatır.

Proxy ve TLS doğrulama seçenekleri masaüstü ayarlarında bulunur ve uygulama yeniden başlatıldığında transfer motoruna uygulanır. TLS doğrulamasını kapatmak yalnızca denetimli test ortamlarında önerilir.

## Statik kontroller

```powershell
npm run check
python -m compileall -q backend
```

## Windows kararlı sürüm paketi

Paketleme bağımlılıklarını kurup NSIS kurulum dosyasını üretin:

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements-build.txt
npm install
npm run dist
```

Çıktı `dist\Internet Manager Setup 1.0.0.exe` konumuna yazılır. İmzalı GitHub sürümlerindeki `latest.yml` ve blockmap dosyaları otomatik güncelleme altyapısı tarafından kullanılır. `v1.0.0` etiketiyle çalışan yayın iş akışı, motoru ve installer'ı imzalamadan sürüm yayımlamaz.

## v1.0 kapsamı

- HTTP/HTTPS dosyası indirme
- Windows kayıt konumu seçici
- İlerleme, hız ve kalan süre
- Aktif indirmeyi iptal etme
- Electron ile Python arasında JSON Lines mesajlaşması
- SQLite tabanlı transfer geçmişi
- Duraklatma ve HTTP Range ile devam ettirme
- Uygulama yeniden açıldığında yarım görevleri kurtarma
- Bağlantı hatalarında üç kez otomatik yeniden deneme
- Dosya çakışmalarında üzerine yazma, yeniden adlandırma veya atlama
- Öncelikli transfer kuyruğu ve eşzamanlı indirme sınırı
- Destekleyen sunucularda dört parçalı paralel indirme
- Genel ve görev bazlı hız limiti
- Beş saniyelik hareketli pencereyle hız ve kalan süre hesabı
- İndirme öncesi boş disk alanı kontrolü
- Seçilen görevleri toplu duraklatma, sürdürme ve iptal etme
- SFTP ve WebDAV bağlantı profilleri
- Windows güvenli depolamasıyla şifrelenmiş profil parolaları
- Bağlantı testi, profil düzenleme ve silme
- Tekli/çoklu dosya seçimi ve sürükle-bırak yükleme
- Yükleme kuyruğu, ilerleme, hız limiti, iptal ve yeniden deneme
- Tarayıcı eklentisi olmadan `Ctrl+Alt+D` hızlı yakalama paneli
- Panodaki HTTP/HTTPS sayfasını veya doğrudan dosya bağlantısını tarama
- Sayfadaki açık dosya, belge, arşiv, görsel, ses ve video bağlantılarını listeleme
- Seçilen sonuçları normal indirme kuyruğuna ekleme
- Ortak SFTP, WebDAV ve S3 upload provider sözleşmesi
- S3 uyumlu servisler için endpoint, bölge, bucket ve erişim anahtarı profilleri
- 8 MB ve üzeri S3 yüklemelerinde multipart aktarım
- Multipart oturum ve tamamlanan parça bilgilerinin SQLite'ta saklanması
- S3 yüklemelerini duraklatma ve aynı multipart oturumundan sürdürme
- SFTP, WebDAV ve S3 uzak klasör/dosya listeleme
- Yükleme ekranından uzak klasör seçme
- Provider yeteneklerini bağlantı testinde ve yükleme ekranında gösterme
- S3 iptalinde yarım uzak multipart oturumunu temizleme
- Profil içe/dışa aktarma; parola, secret key ve session token dışa aktarılmaz
- WebDAV ve S3 yüklemelerinde oluşan uzak nesne adresini panoya kopyalama
- Sistem tepsisi ve pencere kapatıldığında isteğe bağlı arka planda çalışma
- Transfer tamamlanma ve hata bildirimleri
- Windows ile otomatik başlatma seçeneği
- Açık, koyu ve sistem teması
- Türkçe/İngilizce yerelleştirme altyapısı
- Transferleri indirme veya yükleme yönüne göre filtreleme
- Transfer ayrıntıları ile yerel dosyayı veya klasörü açma
- Kalıcı, filtrelenebilir aktivite ve hata günlüğü
- Yeni indirme, yeni yükleme, ayarlar ve aktivite için klavye kısayolları
- Toplu bağlantı ekleme: çoklu URL yapıştırma, `.txt`/`.csv` içe aktarma, tarama önizlemesi ve zaten kuyrukta olanları algılama
- Bağlantıları veya dosyaları pencereye sürükleyip bırakarak hızlı ekleme
- Komut satırından veya `internet-manager://` özel protokolünden bağlantı/dosya yolu ekleme
- İsteğe bağlı pano bağlantısı algılama ve kuyruğa ekleme önerisi
- İndirme/yükleme için kaydedilebilir görev şablonları
- Görev zamanlama: belirli tarih/saatte başlatma, günlük/haftalık tekrar
- Saat aralığına göre otomatik hız limiti
- Kaçırılmış zamanlanmış görevler için "hemen başlat" veya "atla" tercihi
- Bağlantı kesilince transferleri duraklatıp bağlantı gelince otomatik sürdürme
- Tüm transferler bitince uygulamayı kapatma, bilgisayarı uyutma veya kapatma (30 saniyelik iptal edilebilir geri sayımla)
- Sürümlü ve geriye uyumlu SQLite migration sistemi ile bütünlük denetimi
- HTTP/HTTPS proxy ve isteğe bağlı TLS sertifika doğrulama ayarı
- Token, kimlik bilgisi ve hassas URL parametrelerini temizleyen aktivite günlüğü
- Sistem, runtime ve veritabanı durumunu içeren dışa aktarılabilir tanılama paketi

Hızlı yakalamayı kullanmak için bağlantıyı tarayıcıda kopyalayın ve uygulama çalışırken `Ctrl+Alt+D` tuşlarına basın. Tarama yalnızca herkese açık HTTP/HTTPS içeriklerini ve sayfanın statik HTML bağlantılarını görür; tarayıcı oturumuna, giriş yapılmış sayfalara, JavaScript ile sonradan üretilen bağlantılara veya DRM içeriğine erişmez.

v0.5 ile gelen S3 desteği bir Python bağımlılığı ekler. Güncel `requirements.txt` dosyasını bir kez kurmanız gerekir. S3 nesne adresinin üretilmesi, nesnenin herkese açık olduğu anlamına gelmez; erişim politikası depolama servisinde yönetilir.
