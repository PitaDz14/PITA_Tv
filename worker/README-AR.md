# تشغيل قنوات HTTP على موقع HTTPS (قناة W9)

المتصفح يمنع صفحة HTTPS من تحميل بث HTTP (Mixed Content). الحل: وسيط HTTPS مجاني على Cloudflare Workers.

1. ادخل إلى https://dash.cloudflare.com ← Workers & Pages ← Create ← Create Worker ← سمّه مثلاً `pita-proxy` ← Deploy.
2. اضغط Edit code، احذف الكود الموجود والصق محتوى الملف `hls-proxy.js` ثم Deploy.
3. انسخ رابط الـ Worker (مثل `https://pita-proxy.xxxx.workers.dev`).
4. في `index.html` ابحث عن `PROXY_BASE` واستبدل `https://REPLACE-ME.workers.dev/` برابطك (مع `/` في النهاية).
5. ارفع `index.html` إلى GitHub.

## إضافة قناة HTTP أو تغيير رابطها
في `index.html` اكتب الرابط كما هو (http) داخل البطاقة، والموقع يحوّله تلقائياً إلى HTTPS:

```html
<div class="channel-card french" onclick="playChannel('اسم القناة', 'http://السيرفر/المسار/القناة.m3u8')">
  <i class="fas fa-tv channel-icon"></i>
  <div class="channel-name">اسم القناة</div>
  <div class="play-overlay"><div class="play-btn"><i class="fas fa-play"></i></div></div>
</div>
```
لتغيير رابط قناة موجودة: استبدل الرابط الذي بين علامتي الاقتباس الثانيتين فقط. لا حاجة لتعديل الـ Worker.
(الوسيط يعمل للروابط التي تنتهي بـ m3u8 فقط.)

## روابط TS المباشرة (تنتهي بـ .ts)
اكتب الرابط كما هو، والموقع يشغّله تلقائياً بمكتبة `vendor/mpegts.js`:
```html
onclick="playChannel('اسم القناة', 'http://السيرفر/live/المستخدم/كلمة_المرور/174426.ts')"
```
مهم: عند الرفع إلى GitHub ارفع أيضاً الملف الجديد `vendor/mpegts.js`.
نصيحة: سيرفرات هذا النوع تقدّم غالباً نفس القناة بصيغة HLS أيضاً؛ جرّب استبدال `.ts` بـ `.m3u8` في الرابط، فهي عادة أكثر استقراراً.

## تحديث (روابط بلا امتداد + تشخيص)
- الوسيط الآن يتجسّس على أول بايتات الرد للروابط التي لا تنتهي بـ `.m3u8`/`.ts`: إن كانت قائمة HLS يعيد كتابتها تلقائيًا، وإن كانت بثّ TS خامًا يمرّره كما هو.
- **مهم:** بعد أي تعديل على `hls-proxy.js` الصقه في Cloudflare ← Edit code ← Deploy.
- عند فشل قناة يظهر الآن فوق المشغّل سبب الفشل (رد السيرفر، أو ترميز غير مدعوم…).
- صفحة `test.html` (افتحها من موقعك على github.io) تفحص أي رابط وتعرض: رمز HTTP، نوع المحتوى، أول البايتات، وترميز الفيديو/الصوت.
