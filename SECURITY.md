# Güvenlik Politikası

## Desteklenen sürümler

Internet Manager şu anda v0.x geliştirme aşamasındadır. Güvenlik düzeltmeleri yalnızca en güncel `main` dalına ve en son yayımlanan sürüme uygulanır; eski v0.x sürümleri için geriye dönük yama yapılmaz.

| Sürüm | Destek |
| --- | --- |
| En güncel (main) | ✅ |
| Daha eski sürümler | ❌ |

## Zafiyet bildirimi

Bir güvenlik açığı bulduysanız **lütfen GitHub Issues üzerinden herkese açık şekilde paylaşmayın.**

Bunun yerine [github.com/omerbugrae/Internet-Manager/security/advisories](https://github.com/omerbugrae/Internet-Manager/security/advisories) üzerinden özel bir güvenlik danışma raporu (private security advisory) açın. Mümkünse şunları ekleyin:

- Zafiyetin kısa açıklaması ve etkisi
- Yeniden üretme adımları (varsa PoC)
- Etkilenen dosya/bileşen
- Önerdiğiniz çözüm (isteğe bağlı)

Bildirimler elden geldiğince hızlı değerlendirilir; ancak bu proje gönüllü/bireysel olarak geliştirilmektedir, belirli bir yanıt süresi garanti edilmez.

## Sorumluluk reddi

Bu yazılım **"olduğu gibi" (as is)**, hiçbir açık ya da zımni garanti verilmeden, [GPL-3.0](LICENSE) lisansı kapsamında sunulur. Lisansın 15–17. maddelerinde belirtildiği üzere:

- Yazılımın hatasız veya kesintisiz çalışacağına dair hiçbir garanti verilmez.
- Yazılımın kullanımından doğabilecek veri kaybı, dosya bozulması, hatalı transfer, üçüncü taraf sunucu/servis erişimi veya başka herhangi bir doğrudan/dolaylı zarardan geliştirici(ler) sorumlu tutulamaz.
- Bağlantı bilgileri (SFTP/WebDAV/S3 kimlik bilgileri), indirilen/yüklenen dosyaların içeriği ve bunların yasallığı tamamen kullanıcının sorumluluğundadır.
- Üçüncü taraf sunuculardan indirilen içeriklerin güvenliği, doğruluğu veya telif durumu bu proje tarafından denetlenmez.

Üretim ortamında veya kritik verilerle kullanmadan önce kendi risk değerlendirmenizi yapmanız ve düzenli yedek almanız önerilir.

## Bilinen tasarım sınırları ve dikkat edilmesi gerekenler

Bunlar "zafiyet" olarak raporlanmasına gerek olmayan, bilinçli tasarım kararları veya kullanıcının dikkat etmesi gereken noktalardır:

- **Kimlik bilgisi saklama**: SFTP/WebDAV/S3 parolaları ve erişim anahtarları Windows'un `safeStorage` (DPAPI) mekanizmasıyla şifrelenir. Bu şifreleme **kullanıcı Windows hesabına bağlıdır** — aynı Windows kullanıcı oturumuna erişimi olan başka bir uygulama veya kişi, teorik olarak şifreyi çözebilir. Paylaşımlı bilgisayarlarda dikkatli olun.
- **SSRF koruması**: Akıllı yakalama ve bağlantı tarama özellikleri, taranan URL'lerin yerel/özel ağ adreslerine (`127.0.0.1`, `10.0.0.0/8` vb.) çözümlenmediğini DNS çözümleme aşamasında kontrol eder. Bu kontrol DNS rebinding gibi ileri düzey saldırılara karşı %100 garanti değildir.
- **Uzak sunucu güveni**: Uygulama, eklediğiniz SFTP/WebDAV/S3 sunucularına tamamen güvenir. Kötü niyetli veya ele geçirilmiş bir sunucu, dosya adları veya yanıt başlıkları üzerinden beklenmeyen davranışlara yol açabilir.
- **İndirilen dosyalar taranmaz**: Internet Manager bir antivirüs değildir; indirilen dosyaların içeriği güvenlik açısından denetlenmez.
- **Yerel IPC sınırı**: Electron renderer süreci `contextIsolation` ve `sandbox` etkin çalışır; Python motoru yalnızca yerel stdin/stdout üzerinden konuşur ve dışa açık bir ağ portu açmaz.

## Kapsam dışı

- Üçüncü taraf bağımlılıklarındaki (Electron, Python paketleri) zafiyetler — ilgili projenin kendi güvenlik kanalına bildirilmelidir.
- Kullanıcının kendi sunucu/depolama yapılandırmasından kaynaklanan zafiyetler.
- Sosyal mühendislik, fiziksel erişim veya zaten ele geçirilmiş bir işletim sistemi üzerinden yapılan saldırılar.
