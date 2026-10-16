# PITA TV – قنوات الفجر و Sport

## قنوات Sport (نظام مُحوّلات المصادر — قابل للتوسّع)

- `config/sources.json`: تعريف منصات البث الخارجية. **إضافة منصة جديدة = عنصر جديد هنا فقط، دون تعديل أي كود.**
- `config/sports.json`: قنوات Sport 1…15 وربط كل قناة بمصدرها.
- `scripts/extract.py`: المستخرج الموحّد — يجلب الصفحة، يجمع الحمولات (HTML + ملفات JS + JSON)،
  ثم يشغّل محلّلات متسلسلة: مصفوفة كائنات JS ← JSON ← روابط m3u8 عارية ← base64،
  ويرجّح المرشّحين، و**يفحص صحة الرابط فعليًا** قبل قبوله، ويكتب بنفس مخطط قنوات الفجر.
- `scripts/test_extract.py`: اختبارات وحدة للمحلّلات (بدون شبكة).
- `sport.html`: صفحة مشغل **عامة** — تقرأ المعرّف من الرابط (`sport.html?id=sport3`)،
  فلا نحتاج ملفًا جديدًا لكل قناة.
- `.github/workflows/update-sports.yml`: يحدّث `streams/sport*.json` كل 30 دقيقة (بدون Playwright).

### إضافة منصة جديدة (بدون برمجة)

1. أضف عنصرًا في `config/sources.json`:
   ```json
   { "id": "myplatform", "kind": "auto", "page": "https://example.tld/live" }
   ```
   `hints` اختيارية — بدونها يعمل الاكتشاف التلقائي؛ ومعها يصبح الاستخراج أدق.
   و`channel_page` اختيارية لبناء رابط صفحة القناة الواحدة داخل `source_url`:
   ```json
   { "id": "alwan", "kind": "auto", "page": "https://alwanlive.stream/",
     "channel_page": "https://alwanlive.stream/?channel={channel}" }
   ```
   يدعم `{channel}` (قيمة `source_channel`) و`{id}` (معرّف القناة في المنصة) و`{name}`.
   بدونها يُكتب رابط المنصة العام.

### الحل الثانوي عند فشل الاستخراج

إذا فشل استخراج رابط البث، يُكتب ملف القناة بحالة `fallback` مع رابط صفحة القناة،
ويعرضه `sport.html` داخل إطار مع رابط قابل للفتح أسفل الصفحة — بدل رابط ميّت أو رسالة فاضية.

**ولماذا `sports.js`؟** لو تعذّر قراءة `streams/<id>.json` نفسها (ملف غير منشور، أو فتح الموقع
ببروتوكول `file://`، أو خطأ شبكة) فلا يعرف المشغّل رابط الصفحة الاحتياطية أصلًا. لذلك يولّد
`extract.py` ملف `sports.js` — خريطة `{ "sport1": "https://…/?channel=1", … }` تُحمَّل بوسم
`<script>` عادي (لا يخضع لقيود fetch) فيبقى الحل الثانوي متاحًا في كل الحالات. الملف **مولَّد
آليًا** من `config/sports.json` + `config/sources.json`، ويرفعه الـ workflow مع ملفات البث.

أولوية اختيار الصفحة:
1. `fallback_url` المكتوب صراحةً في `config/sports.json` (يفيد القنوات بلا مصدر).
2. صفحة القناة الواحدة المبنية من قالب `channel_page` في `config/sources.json`.
3. صفحة المنصة العامة.

حالات ملف القناة: `ok` (رابط يعمل) · `stale` (بث المصدر ميّت مع إبقاء رابط قديم يعمل) ·
`fallback` (لا رابط، تُعرض صفحة القناة) · `offline` · `unconfigured`.
2. اربط القنوات في `config/sports.json`:
   ```json
   { "id": "sport11", "name": "Sport 11", "source": "myplatform", "source_channel": 3 }
   ```
3. شغّل `python scripts/extract.py` — وانتهى.

### أنواع المصادر (`kind`)

| النوع | يستخدم | لمن |
|---|---|---|
| `auto` | خط الأنابيب أعلاه (بدون متصفح) | **الافتراضي** — يكفي رابط المنصة |
| `direct` | رابط `.m3u8` جاهز في `config/sports.json` | قنوات بروابط ثابتة |
| `crypt` | POST إلى `endpoint` ثم فكّ AES-CBC (بدون متصفح) | منصات تُخفي الرابط في JSON مشفّر — مثل قنوات الفجر |
| `browser` | مستخرج Playwright (`update_streams.py`) | صفحات تُنشئ الروابط عبر JavaScript (لم تُعد مجدولة) |

### محوّل `crypt` (المصادر المشفّرة)

بعض المنصات لا تكتب الرابط في الصفحة، بل تعيده **مشفّرًا** من نقطة نهاية POST:

```
GET  صفحة القناة            → csrf-token + كعكة جلسة
POST endpoint (id+csrf)     → JSON: { link_4, key, iv }
AES-256-CBC فكّ link_4      → رابط .m3u8 مع token
```

كل ذلك بـ Python خالص (`scripts/aes_cbc.py`، بلا أي مكتبة خارجية) — **بدون متصفح**،
فيعمل في CI بثبات. الإعداد:

```json
{ "id": "elahmad", "kind": "crypt",
  "page": "https://www.elahmad.ru/tv/watchtv.php",
  "channel_page": "https://www.elahmad.ru/tv/watchtv.php?id={channel}",
  "endpoint": "https://www.elahmad.ru/tv/result/embed_result_watchtv.php",
  "cipher_field": "link_4", "key_field": "key", "iv_field": "iv" }
```

أسماء الحقول و`csrf_regexes` قابلة للتغيير من الإعداد — فمنصة مشفّرة مشابهة
تحتاج عنصرًا جديدًا في `sources.json` فقط. `scripts/test_aes_cbc.py` يقارن
تنفيذ AES بمتجهات FIPS-197 الرسمية وبمكتبة `cryptography` المرجعية.

### حدود الأمانة

لا يوجد مستخرج «كوني» 100%. مدعوم تلقائيًا: منصات بياناتها في مصفوفة/JSON داخل الصفحة أو ملف JS،
أو روابطها عارية/بـ base64 في HTML. ما يحتاج تنفيذ JS يُخدَم بمحوّل `browser`.
منصة بترميز مخصّص أو DRM تحتاج محوّلًا صغيرًا جديدًا — إضافة معزولة لا إعادة كتابة.

## قنوات الفجر

- `alfajertv1.html` … `alfajertv5.html`: صفحة مشغل لكل قناة، تقرأ `streams/<id>.json` وتتحقق من رابط جديد كل دقيقة.
- الاستخراج صار عبر **محوّل `crypt`** نفسه المستخدم لقنوات Sport (انظر أعلاه):
  قنوات الفجر مضافة في `config/sports.json` بمصدر `elahmad` — بلا Playwright،
  وكانت تُستخرج سابقًا بمتصفح يتعطّل كثيرًا.
- `config/channels.json`: أسماء القنوات وروابط صفحاتها في المصدر (مرجع تاريخي؛
  الربط الفعّال الآن في `config/sports.json`).
- `scripts/update_streams.py`: بقي مكتبة مساعدة (الترجيح، حلّ Master→Media، اختبارات HLS)
  ويخدم نوع `browser` — لم يعد مجدولًا.
- `scripts/test_hls_resolution.py`: اختبارات حلّ Master→Media Playlist وتوريث الـ token.
- `.github/workflows/update-alfajer.yml`: يحدّث `streams/alfajertv*.json` كل 10 دقائق
  (أو يدويًا من Actions) ويعمل commit عند التغيير فقط.

**ملاحظة عن Alfajer TV 1**: المصدر نفسه لا يبثّ فيديو لهذه القناة حاليًا
(صفر وحدات H.264 في كل مقاطع البث — صوت فقط)، وهذا عيب من جهة المنصة لا من جهتنا.

## Duhok

- `player.html` + `stream.json` + `.github/workflows/update-stream.yml`: مشغل Duhok (بدون تغيير).
