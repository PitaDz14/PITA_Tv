# إضافة قناة جديدة (خطوة واحدة)

1. في `index.html` انسخ أي بطاقة قناة والصق رابطها **الحقيقي** كما كنت تفعل سابقًا:
   `onclick="playChannel('اسم القناة', 'https://.../index.m3u8')"` (أضف `, 'ts'` لروابط TS).
2. شغّل:  `python3 tools/protect.py`
   - يستبدل الرابط بمعرّف مبهم `k:xxxxxxxxxx` في index.html.
   - يحفظ الرابط الحقيقي في `private/channels.json` (لا يُرفع إلى GitHub — احتفظ بنسخة احتياطية).
   - يبني `worker/dist/worker.js`.
3. Cloudflare ← Workers ← worker الخاص بك ← Edit code ← الصق محتوى `worker/dist/worker.js` ← Deploy.
4. ارفع `index.html` إلى GitHub.

تغيير رابط قناة: عدّله في `private/channels.json` ثم نفّذ الخطوتين 2 و3 (لا حاجة لرفع index.html).
قبل الرفع: `python3 tools/protect.py --check` يتأكد أنه لا رابط ظاهر.
إخفاء أقوى (حتى من تبويب Network) لكل قنوات HLS/TS: `python3 tools/protect.py --proxy-all` (يستهلك طلبات Worker أكثر).
