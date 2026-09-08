# Internet Manager

Electron arayüzü ve Python transfer motoruyla geliştirilen ücretsiz indirme/yükleme yöneticisi.

## v0.4.1'i çalıştırma

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

## Statik kontroller

```powershell
npm run check
python -m compileall -q backend
```

## v0.4.1 kapsamı

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

Hızlı yakalamayı kullanmak için bağlantıyı tarayıcıda kopyalayın ve uygulama çalışırken `Ctrl+Alt+D` tuşlarına basın. Tarama yalnızca herkese açık HTTP/HTTPS içeriklerini ve sayfanın statik HTML bağlantılarını görür; tarayıcı oturumuna, giriş yapılmış sayfalara, JavaScript ile sonradan üretilen bağlantılara veya DRM içeriğine erişmez.
