# Liszt

Claude Code oturumlarını proje sekmeleri ve bölünmüş paneller içinde çalıştıran kişisel terminal.
Electron + xterm.js + node-pty. Her panel gerçek `claude` CLI'ını çalıştırır; durum bilgisi Claude
Code hook'larından gelir.

## Çalıştırma

```bash
npm install
npm start
```

## Uygulama olarak kurma

```bash
npm run dist:mac
ditto release/mac-arm64/Liszt.app /Applications/Liszt.app
```

- Paket Apple Silicon için ve ad-hoc imzalı. Bu Mac'te derlendiği için Gatekeeper sormadan açılır;
  başka bir Mac'e kopyalanırsa ilk açılışta sağ tık → Aç gerekir.
- İkon `scripts/make-icon.py` ile `build/icon.png` olarak çizilir.
- Geliştirme sürümü (`npm start`) ile kurulu uygulama aynı veri klasörünü kullanır ve aynı anda
  yalnızca biri açık kalabilir.

## Kısayollar

| Kısayol | İş |
|---|---|
| ⌘T / ⇧⌘T | Yeni Claude oturumu / yeni shell (odaktaki bölmede açılır) |
| ⌘D / ⇧⌘D | Yeni Claude oturumunu sağa / alta bölerek aç |
| ⌘W | Odaktaki oturumu kapat |
| ⌘O / ⇧⌘W | Proje ekle / projeyi kapat |
| ⌘1…9, ⇧⌘] / ⇧⌘[ | Projeler arasında geçiş |
| ⌘] / ⌘[ | Oturum sekmeleri arasında geçiş |
| ⌘B | Changes (git) panelini aç/kapat |
| ⌘L | Sessions panelini aç/kapat (arama kutusuna odaklanır) |
| ⌘J | Tasks panelini aç/kapat |
| ⌘= / ⌘- / ⌘0 | Yazı boyutu |
| ⇧↩ | Claude prompt'unda yeni satır |
| Başlığa çift tık | Oturumu yeniden adlandır |
| Oturum sekmesine ya da başlığa sağ tık | Oturum menüsü |
| Bölme çizgisine çift tık | Bölmeleri eşit boyuta getir |

## Sekmeler ve bölmeler

- Üst sıra projelerdir; her proje bir sekme yığınıdır (Vivaldi'deki gibi). Açık yığının oturumları
  alttaki ikinci sırada sekme olarak durur. Arka plandaki sekmeler çalışmaya devam eder.
- Proje sekmelerini sürükleyerek sıralayabilirsiniz; ⌘1…9 bu sırayı izler.
- Projeler, tarayıcıdaki sekme grupları gibi adlı ve renkli **gruplarda** toplanabilir. Grubun renkli
  etiketi projelerinin önünde durur, projelerin altı grubun rengiyle çizilir.
  - Proje menüsündeki **Add to Group → New Group** grubu açar ve adını hemen yazdırır; ad boş kalırsa
    etiket yalnızca renk olur. **Move to Group** projeyi başka bir gruba, **Remove from Group** grubun
    hemen sağına taşır.
  - Etikete tıklamak grubu katlar: yalnızca etiket, proje sayısı ve gizlenen projelerin en acil durum
    noktası kalır. Açık proje bu gruptaysa sekmesi görünmeye devam eder.
  - Sürükleme: bir projeyi bir grubun projeleri arasına bırakmak onu o gruba katar, gruplanmamış
    sekmelerin arasına bırakmak gruptan çıkarır. Etiketin sağ yarısına bırakılan proje grubun başına
    girer, sol yarısına bırakılan grubun önüne geçer. Etiketi sürüklemek grubu bütün olarak taşır.
  - Etikete sağ tıklayınca grup menüsü açılır: **Rename…**, **Color**, **Collapse / Expand**,
    **Add Project to Group…** (klasör seçtirir; zaten açık olan bir klasörü gruba taşır), **Ungroup**
    (projeler yerinde kalır) ve **Close Group** (gruptaki projeleri kapatır). Son projesi giden grup
    kendiliğinden kalkar.
- Sağ tık menüleri ve açılır listeler (Sessions'taki Show / Sort, Autopilot'un `max`'ı) macOS'un
  menüleri değil, Liszt'in kendi menüleridir. Ok tuşları, Enter, Esc ve harfle atlama çalışır;
  menü açıkken tuşlar terminale gitmez. Dışarı tıklamak menüyü kapatır ama tıklanan yere ulaşmaz,
  başka bir yere sağ tıklamak oranın menüsünü açar.
- Bir proje sekmesine sağ tıklayınca proje menüsü açılır:
  - **Rename…** projenin adını sekmenin üzerinde düzenletir; Enter kaydeder, Esc vazgeçer. Adı
    silip kaydetmek ya da **Use Folder Name** klasörün adına döner.
  - **Add to Group / Move to Group / Remove from Group**, yukarıda anlatıldığı gibi.
  - **Fold** sekmeyi katlar: yalnızca ikonu ve yanındaki durum noktası kalır, adı üzerine gelince ipucunda
    görünür. **Unfold** geri açar; **Fold Others** diğer projeleri katlar, **Unfold All** hepsini açar.
  - **Choose Icon… / Detect Icon Again**, **Reveal in Finder** ve **Close Project**.
- Bir oturum sekmesini (ya da bir bölmenin başlığını) sürükleyin:
  - Sekme sırasına bırakırsanız yer değiştirir.
  - Bir terminalin ortasına bırakırsanız onun yerine geçer.
  - Bir terminalin kenarına bırakırsanız o tarafa bölünür.
- Bir oturum sekmesine (ya da bölmenin başlığına) sağ tıklayınca oturum menüsü açılır:
  - **Rename…** adı sekmenin üzerinde düzenletir; Enter kaydeder, Esc vazgeçer. Adı silip
    kaydetmek ya da **Use Automatic Name** Claude'un verdiği başlığa döner.
  - **Rename with Claude** adı Claude Code'a koydurur: oturuma argümansız `/rename` yazar, model
    konuşmaya bakıp kısa bir ad üretir (`fix-login-bug` gibi). Ad oturumun Claude Code'daki adı olur
    (`/resume`, `claude agents`) ve terminal başlığı olarak sekmeye gelir; Liszt'te elle verilmiş adın
    yerine geçer. Model ad üretemezse hiçbir şey değişmez. Yalnızca Claude sırasını bitirmiş, prompt
    beklerken açıktır. Prompt kutusunda yarım bir taslak varsa önce Ctrl+S ile kenara alınır, komut
    bitince Claude Code onu geri koyar. Ctrl+S ile saklanmış başka bir taslak daha varsa onu ezmemek
    için Liszt bir şey yazmaz ve uyarır. Kutu ekranda değilse (bir menü ya da soru açıksa) de bir şey
    yazılmaz.
  - **Mark as Unread / Mark as Read** oturumu sonra dönmek üzere okunmamış işaretler ya da işareti
    kaldırır.
  - **Split Right / Split Down** oturumu odaktaki bölmenin yanına koyar; **Take Out of Split** onu
    bölmeden alır.
  - **Reveal in Finder**, **Copy Session ID** (`claude --resume <id>` için), **Close Session** ve
    **Close Other Sessions**.
- Claude cevabını bitirdiğinde o oturuma bakmıyorsanız oturum okunmamış olur: durum noktası Idle
  halkası yerine yeşil dolu nokta olur, sekme başlığı kalınlaşır, etiket **Unread** yazar ve proje
  sekmesinin noktası da yeşile döner. Oturuma geçmek, içine tıklamak ya da yazmak onu okur;
  pencereye geri dönmek okumaz. İşaret `state.json`'da saklanır, yeniden açılışta da kalır. Liszt
  kapalıyken işini bitiren oturum da açılışta okunmamış görünür.
- Claude turunu bitirdiği halde başlattığı arka plan işleri sürüyorsa (örneğin `run_in_background` ile
  çalışan bir shell komutu) oturum bitmiş sayılmaz: etiket sarı **Waiting · 2m** olur, nokta sarı
  halkaya döner. Etiketin ipucu ve Sessions satırı neyin beklendiğini yazar
  (`Waiting on shell · Run the test suite`). İş bitince Claude kaldığı yerden devam eder; bildirim ve
  **Unread** ancak son turu bitince gelir, task kartı da o zamana kadar In progress'te kalır.
- Bölmeler arasındaki çizgiyi sürükleyerek boyutlandırabilirsiniz. Bölme başlığındaki "çıkar" ikonu
  oturumu bölmeden alır ama sekme olarak çalışmaya devam ettirir.
- Proje ikonları projenin kendisinden bulunur: Unity'nin uygulama ikonu, Godot'nun `config/icon`'u,
  Xcode `AppIcon`'u, Next.js `app/icon`'u, Tauri `src-tauri/icons/icon.png`'si, `build/icon.png`,
  `logo`/`favicon` dosyaları. Bulunamazsa proje türüne göre bir
  simge çizilir. Proje menüsündeki **Choose Icon…** ile elle seçilebilir.
- Sol paneli Changes ya da **Sessions** kaplar, ikisi aynı anda açık olmaz: sağ üstteki düğmelerden
  (ya da ⌘B / ⌘L) biri açılınca diğeri kapanır.
- **Sessions** makinedeki tüm Claude Code oturumlarını üç başlık altında listeler:
  - **In Liszt**: Liszt'teki paneller. Satırda durum, süre ve Claude'un son yaptığı iş (örneğin
    `Edit · main.ts`) görünür.
  - **Running elsewhere**: Liszt dışında çalışanlar. Bunlar başka terminaller, Claude masaüstü
    uygulaması ve arka plan oturumlarıdır.
  - **Not running**: Hiçbir sürecin çalıştırmadığı oturumlar. Bunlar bitmiş ya da durdurulmuş arka
    plan oturumları (örneğin `/open-agents`'ın `agent1`, `agent2` agent'ları), Claude masaüstü
    uygulamasının sakladığı oturumlar ve Claude Code'un konuşma kaydını hâlâ tuttuğu diğer her
    oturumdur: terminalde çalışıp kapanmış oturumlar, masaüstü uygulamasının artık listelemedikleri,
    Agent SDK çalıştırmaları ve kapatılmış Liszt panelleri. Satırın alt yazısı oturumu neyin
    çalıştırdığını söyler (**Terminal**, **Claude app**, **Agent SDK**). Arşivlenenler (**Archived**) de
    buradadır.
- Sabitlenen oturumlar grubunun en üstünde, adının önünde turuncu bir iğne simgesiyle durur. Hem
  masaüstü uygulamasında hem `claude agents` görünümünde sabitlenenler bu şekilde gösterilir.
- Arama kutusu başlık, proje, klasör ve durum metninde arar; büyük/küçük harf ve Türkçe karakter
  farkını önemsemez (`gecis` → "geçiş"). Enter ilk sonucu açar, Esc kutuyu temizler.
- **Show**: Active (arşivlenmemiş ve açılabilen her şey, varsayılan), In Liszt, Running, Unread,
  Pinned, Archived, All. Klasörü ya da konuşma kaydı silinmiş oturumlar açılamaz; yalnızca All'da
  görünürler.
  **Sort**: Status (sizi bekleyenler önce), Recent, Name, Project (proje başlıklarıyla gruplar).
- Satıra tıklayınca Liszt panelinin yerine gidilir. Dışarıdaki bir oturumda ise klasörü proje değilse
  proje olarak eklenir ve oturum yeni bir panelde açılır: arka plan oturumu `claude attach <id>` ile
  (bitmişse uyandırılır, son konuşmasıyla açılır), diğerleri `claude --resume <sessionId>` ile.
  Klasörü ya da konuşma kaydı silinmiş bir oturum soluk görünür ve açılmaz.
- Bir satıra sağ tıklayınca (ya da üzerine gelince sağda beliren **⋯** düğmesine basınca) oturum
  menüsü açılır:
  - **Mark as Unread / Mark as Read** oturumu sonra dönmek üzere okunmamış işaretler ya da işareti
    kaldırır; Liszt dışındaki oturumlar için de çalışır. Okunmamış oturum yeşil noktası, kalın
    başlığı ve **Unread** etiketiyle grubunun en üstüne çıkar (bir şey üzerinde çalışırken durumu
    görünür, iş bitince yine Unread olur). Oturumu açmak onu okur. Okunmamış bir Liszt paneli
    kapatılınca oturumu Not running altında okunmamış kalır.
  - **Close Session** oturumu kapatır, konuşma kalır. Liszt panelindeyse panel kapanır. Arka plan
    oturumu `claude stop <id>` ile durdurulur. Başka bir terminalde ya da masaüstü uygulamasında
    çalışan etkileşimli oturumun süreci sonlandırılır (SIGTERM); bunu yapmadan önce Liszt sorar.
  - **Archive** oturumu arşivler; çalışıyorsa önce kapatır (**Close and Archive**). Arşivlenen oturum
    Active'den çıkar, **Archived** altında görünür, tıklayınca yeniden açılır. **Unarchive** geri alır.
    Arşiv Liszt'in kendisinindir: masaüstü uygulamasının dosyalarına yazılmaz. Liszt'in seçimi
    uygulamanınkinin önüne geçer, yani uygulamada arşivli bir oturum Liszt'te arşivden çıkarılabilir.
    Arşivlenen oturumun başlığı ve klasörü saklanır; Claude Code konuşma kaydını temizlese bile
    Not running altında **Kept by Liszt** olarak kalır.
  - **Delete Session…** onay ister, oturumu kapatır ve konuşmasını
    (`~/.claude/projects/…/<sessionId>.jsonl` ve yanındaki klasör) Çöp Kutusu'na taşır. Arka plan
    oturumu önce `claude rm <id>` ile silinir; çalışma kaybolacaksa Claude Code worktree'yi bırakır
    ve bunu söyler. Masaüstü uygulaması oturumu kendi listesinde tutmaya devam eder, Liszt'te gizlenir.

## Nasıl çalışır

- `src/main/main.ts`: pencere, pty'ler, git sorguları, menü ve hook sunucusu.
- Her Claude paneli bir Claude Code arka plan oturumudur. Liszt oturumu `claude --bg` ile (devam eden
  bir konuşmada `claude --bg --resume <sessionId>` ile) Claude Code'un arka plan sunucusunda başlatır;
  panelin terminali yalnızca `claude attach <id>` çalıştırır. Bu yüzden ⌘Q ile çıkınca oturumlar
  durmaz, çalışmaya devam eder; bir sonraki açılışta paneller aynı oturumlara yeniden bağlanır. Bu
  oturumlar `claude agents` görünümünde de arka plan oturumu olarak listelenir.
- Claude Code güvenmediği klasörde arka plan oturumu başlatmaz. Böyle bir klasörde panel claude'u
  doğrudan `claude --session-id <uuid>` ile açar; güven sorusu orada sorulur ve oturum uygulamayla
  birlikte kapanır. Klasöre bir kez güvenince sonraki açılışta arka plana geçer. Shell panelleri de
  uygulamayla birlikte kapanır.
- Her panel hook'larını (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `PostToolUse`,
  `SessionEnd`) satır içi bir `--settings` JSON'u olarak alır ve panelin kimliği komutun içinde yazılıdır.
  Bunun sebebi, arka plan sunucusunun oturumları panelin değil kendi ortamıyla çalıştırmasıdır. Hook,
  olayı `127.0.0.1` üzerindeki token korumalı sunucuya yollar. Adresi o an `<userData>/hook-url`
  dosyasından okur (dosyayı yalnızca kullanıcı okuyabilir). Böylece önceki açılışta başlamış oturumlar
  da şimdiki Liszt'e ulaşır; Liszt kapalıyken dosya yoktur ve hook bir şey göndermez. Panel etiketleri
  (Running · 1m / Waiting · 1m / Needs you / Unread / Idle) buradan gelir. Yeniden bağlanan panel ilk
  hook gelene kadar durumunu `claude agents` listesinden alır. Liszt'in başlatmadığı oturumlar hook
  göndermez; onların durumu her zaman bu listeden gelir.
- `<userData>/claude-settings.json` yalnızca eski sürümlerin arka plana aldığı oturumlar uyandırılırken
  bulunsun diye yazılır.
- Paneller, projeler ve oturum kimlikleri `~/Library/Application Support/Liszt/state.json` içinde
  saklanır. Uygulama yeniden açıldığında paneller oturumlarına `claude attach <id>` ile bağlanır. Claude
  Code'un artık tanımadığı oturumlar `claude --bg --resume <id>` ile geri gelir.
  Sessions'ta arşivlenen, silinen ve Liszt dışında okunmamış işaretlenen oturumlar da burada, oturum
  kimliğiyle `sessionMarks` altında durur.
- Paneller ancak projesi ilk kez açıldığında başlatılır, böylece çok proje eklemek açılışı yavaşlatmaz.
- Ana süreç 10 saniyede bir `claude agents --json --all` çalıştırır ve listeyi renderer'a yollar. Bir
  panelin oturumuyla eşleşenler yalnızca In Liszt'te görünür. Agent görünümünün sabitledikleri
  `~/.claude/jobs/pins.json`'dan okunur.
- Aynı turda Claude masaüstü uygulamasının oturum dosyaları okunur:
  `~/Library/Application Support/Claude/claude-code-sessions/<hesap>/<org>/local_*.json`. Başlık, klasör,
  `cliSessionId` ve `isArchived` buradan, sabitlenenler `claude_desktop_config.json`'daki
  `starred-local-code-sessions` listesinden gelir. Liszt bu dosyalara yazmaz; her dosya yalnızca
  değiştiğinde yeniden okunur.
- Aynı turda Claude Code'un konuşma kayıtları taranır: `~/.claude/projects/<klasör>/<sessionId>.jsonl`
  (ya da `CLAUDE_CONFIG_DIR` altındaki karşılığı). Oturumu kim başlatmış olursa olsun kaydı buradadır,
  bu yüzden başka hiçbir yerde listelenmeyen oturumlar buradan gelir. Kayıtlar onlarca MB olabildiği
  için her birinin yalnızca ilk ve son 64 KB'ı, dosya değiştiğinde okunur: başlık (`/rename` adı, yoksa
  Claude'un verdiği başlık, yoksa ilk prompt) ve klasör buradan çıkar. Oturum, kaydının durduğu klasöre
  karşılık gelen klasörde `claude --resume` ile açılır. Claude Code eski kayıtları kendisi temizler
  (`cleanupPeriodDays`, varsayılan 30 gün); temizlenen oturum listeden de düşer.
- Claude'u doğrudan çalıştıran bir panelde `/background` yazılırsa Claude Code oturumu arka plan
  sunucusuna (`--bg-pty-host`) yeni bir kimlikle taşır ve panelin süreci `backgrounded · <id>` yazıp
  çıkar. Liszt bu satırı yakalayıp paneli o oturuma bağlar; **Resume** artık `claude attach <id>` ile
  ona bağlanır.
- Bir panel (ya da projesi) kapatılınca oturumu `claude stop <id>` ile durdurulur. Konuşma silinmez:
  oturum Sessions'ta Not running altında Stopped olarak kalır ve tıklayınca `claude attach <id>` ile geri
  gelir. **New session** da panelin eski oturumunu durdurur.
- Login shell ortamı (`.zprofile`, `.zshrc`) bir kez okunur. Böylece Finder'dan açıldığında da
  paneller terminaldeki PATH'i ve değişkenleri görür.

## Task panosu ve Autopilot

- Sağdaki Tasks paneline bir kart yazıp Enter'a basın. Karta tıklayınca Claude'a gidecek ek
  açıklamayı yazabilirsiniz.
- **Start** kartı başlatır:
  - `<repo>/.claude/worktrees/<kart-adı>-xxxx` altında `liszt/<kart-adı>-xxxx` branch'iyle yeni bir
    worktree açar.
  - O worktree'de, kart metniyle başlayan bir Claude paneli açar.
  - Bu klasör ana repoda `git status`'a düşmesin diye `.git/info/exclude` dosyasına eklenir;
    `.gitignore`'a dokunulmaz.
- Claude turunu bitirince (`Stop` hook'u) kart **Review**'a geçer. Siz panelde yazmaya devam
  ederseniz kart tekrar **In progress**'e döner.
- **Done** paneli kapatır. Worktree diskte kalır; Done listesindeki **Remove worktree** onu siler.
  Git, commit edilmemiş değişiklik varsa silmeyi reddeder. Branch her durumda korunur.
- **Autopilot** açıkken, In progress'teki kart sayısı `max` değerinin altına indikçe sıradaki Todo
  kartı kendiliğinden başlatılır. Başlatılamayan kart (örneğin git reposu olmayan bir proje) kırmızı
  hatayla bekler; Autopilot onu atlar ve kart elle **Retry** ile yeniden denenir.
- Worktree'ler repo klasörünün içinde açıldığı için Claude'un klasör güvenini repodan devralır.
  Bir repoya bir kez güvendikten sonra Autopilot güven sorusunda takılmaz.

## Geliştirici notları

- `npm run typecheck`: tip kontrolü. `npm run build`: `dist/` çıktısını üretir.
- `LISZT_USER_DATA=<klasör>`: ayrı bir profille çalıştırır. `LISZT_DEBUG=1` gelen hook'ları,
  durdurulan arka plan oturumlarını ve başlatılamayan bir arka plan oturumunun sebebini konsola yazar. `LISZT_CAPTURE=<dosya.png>` ise birkaç saniye
  sonra (`LISZT_CAPTURE_DELAY` ms, varsayılan 8000) ekran görüntüsü alıp uygulamayı kapatır.
  `LISZT_TEST_SCRIPT=<dosya.js>` sayfa yüklendikten sonra bir betik çalıştırır ve dönen değeri
  `[test]` satırı olarak yazar.
- Arka plan oturumlarını denerken yalnızca test için `claude --bg` ile açtığınız oturumları kullanın;
  `claude stop <id>` ve `claude rm <id>` ile temizleyin.

## Sıradaki adımlar

1. Kartları sürükleyerek sıralama ve Review kartında worktree diff'ini gösterme.
