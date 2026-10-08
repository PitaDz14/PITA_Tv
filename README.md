# PITA TV – قنوات الفجر

- `alfajertv1.html` … `alfajertv5.html`: صفحة مشغل لكل قناة، تقرأ `streams/<id>.json` وتتحقق من رابط جديد كل دقيقة.
- `config/channels.json`: أسماء القنوات وروابط صفحاتها في المصدر.
- `scripts/update_streams.py`: يستخرج رابط `.m3u8` مع الـ token (Playwright).
- `.github/workflows/update-alfajer.yml`: يحدّث `streams/*.json` كل 10 دقائق (أو يدويًا من Actions) ويعمل commit عند التغيير فقط.
- `player.html` + `stream.json` + `.github/workflows/update-stream.yml`: مشغل Duhok (بدون تغيير).
