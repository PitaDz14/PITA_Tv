#!/usr/bin/env python3
"""
tools/protect.py — يخفي روابط البث من index.html.

ماذا يفعل؟
  1) يقرأ index.html ويجد كل بطاقة قناة:  playChannel('الاسم', 'الرابط'[, 'النوع'])  و playFrench(...)
  2) يستبدل الرابط بمعرّف مبهم:            playChannel('الاسم', 'k:3fa9c1d27b')
  3) يحفظ الروابط الحقيقية في  private/channels.json   (مستبعد من git — احتفظ بنسخة احتياطية منه)
  4) يبني  worker/dist/worker.js  = كود الـ Worker + خريطة القنوات   ← هذا الملف الذي تلصقه في Cloudflare

الاستعمال:
  python3 tools/protect.py                 # تحويل البطاقات الجديدة/الحقيقية فقط، وإعادة بناء الـ Worker
  python3 tools/protect.py --proxy-all     # تمرير كل القنوات عبر الـ Worker (إخفاء كامل حتى من تبويب Network؛ استهلاك أكبر)
  python3 tools/protect.py --check         # يفشل إن بقي أي رابط بث ظاهر في index.html (للتحقق قبل الرفع)

لإضافة قناة جديدة: اكتب البطاقة بالطريقة القديمة (رابط حقيقي) ثم شغّل السكربت؛ يحوّلها تلقائيًا.
لتغيير رابط قناة: عدّله في private/channels.json ثم شغّل السكربت (أو الصق الجديد في البطاقة وشغّله).
"""
import argparse
import json
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
PRIVATE = ROOT / "private" / "channels.json"
WORKER_SRC = ROOT / "worker" / "hls-proxy.js"
WORKER_OUT = ROOT / "worker" / "dist" / "worker.js"
MARK = "/*__PRIVATE_CHANNELS__*/ {}"

# رابط الوسيط القديم الملفوف حول الرابط الحقيقي: https://xxx.workers.dev/?u=<الحقيقي>
WRAPPED = re.compile(r"^https://[a-z0-9.-]+\.workers\.dev/\?u=(.+)$", re.I)
# بطاقة:  playChannel('..', '..'[, '..'])  — النص الأول والثاني حرفيّان (لا تعابير مثل PROXY_BASE + ...)
CALL = re.compile(
    r"""(?P<fn>playChannel|playFrench)\(\s*
        (?P<q1>['"])(?P<name>(?:\\.|(?!(?P=q1)).)*)(?P=q1)\s*,\s*
        (?P<q2>['"])(?P<url>(?:\\.|(?!(?P=q2)).)*)(?P=q2)
        (?:\s*,\s*(?P<q3>['"])(?P<type>[a-z]*)(?P=q3))?\s*\)""",
    re.X | re.S,
)
OPEN = re.compile(r"window\.open\('(https?://[^']+)',\s*'_blank',\s*'noopener,noreferrer'\)")
IFRAME_MATCHES = re.compile(r'(<iframe\s+)src="(https://href\.li/\?[^"]+)"')


def classify(url: str, explicit: str, proxy_all: bool):
    """يعيد (الرابط الحقيقي، النوع، الوضع)"""
    mode = "direct"
    m = WRAPPED.match(url)
    if m:                       # كان مُمرَّرًا عبر الوسيط ← يبقى كذلك
        url, mode = m.group(1), "proxy"
    if url.startswith("http://"):   # HTTP صريح يحتاج وسيطًا على موقع HTTPS (وغالبًا فيه بيانات اشتراك)
        mode = "proxy"
    if proxy_all and not re.match(r"https://www\.elahmad\.ru/", url):
        # صفحات/مشغّلات الـ iframe لا تُمرَّر عبر الوسيط (ليست بثًّا خامًا)
        if explicit in ("ts", "hls", "tsaac") or re.search(r"m3u8|\.ts(\?|$)", url, re.I):
            mode = "proxy"
    typ = explicit or ""
    if mode == "proxy" and not typ:
        typ = "hls" if re.search(r"m3u8", url, re.I) else ("ts" if re.search(r"\.ts(\?|$)", url, re.I) else "hls")
    return url, typ, mode


def new_id(existing: set) -> str:
    while True:
        i = secrets.token_hex(5)      # 10 خانات عشوائية: لا يمكن تخمينها ولا اشتقاق الرابط منها
        if i not in existing:
            return i


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--proxy-all", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    html = INDEX.read_text(encoding="utf-8")

    if args.check:
        bad = [m.group(0)[:90] for m in CALL.finditer(html) if re.match(r"https?://", m.group("url")) and "/?c=" not in m.group("url")]
        if OPEN.search(html) or IFRAME_MATCHES.search(html):
            bad.append("iframe src=href.li…")
        if bad:
            print("روابط ظاهرة:", *bad[:10], sep="\n  ")
            sys.exit(1)
        print("OK: لا توجد روابط بث ظاهرة في index.html")
        return

    store = json.loads(PRIVATE.read_text(encoding="utf-8")) if PRIVATE.exists() else {}
    by_key = {(v["url"], v.get("type", "")): k for k, v in store.items()}
    used = set(store)
    stats = {"new": 0, "reused": 0}

    def register(url, typ, mode, name):
        key = (url, typ)
        if key in by_key:
            i = by_key[key]
            store[i]["mode"] = mode
            stats["reused"] += 1
        else:
            i = new_id(used)
            used.add(i)
            store[i] = {"name": name, "url": url, "type": typ, "mode": mode}
            by_key[key] = i
            stats["new"] += 1
        return i

    def repl(m):
        url = m.group("url")
        if not re.match(r"https?://", url):      # معرّف/ملف محلي (watch.html?id=…) ← لا شيء يُخفى
            return m.group(0)
        if "/?c=" in url:                        # قنوات محمية أصلاً (CHANNELS) — تبقى كما هي
            return m.group(0)
        real, typ, mode = classify(url, m.group("type") or "", args.proxy_all)
        i = register(real, typ, mode, m.group("name"))
        return f"{m.group('fn')}({m.group('q1')}{m.group('name')}{m.group('q1')}, 'k:{i}')"

    html = CALL.sub(repl, html)

    # بطاقات تفتح صفحة المصدر في تبويب جديد
    html = OPEN.sub(lambda m: f"openKeyed('k:{register(m.group(1), 'page', 'direct', 'open')}')", html)

    # إطار «بث مباشر للمباريات»: يُحمَّل عند فتح القسم من الـ Worker بدل كتابة رابطه في الصفحة
    def repl_iframe(m):
        i = register(m.group(2), "iframe", "direct", "matches")
        return f'{m.group(1)}data-k="{i}"'
    html = IFRAME_MATCHES.sub(repl_iframe, html)

    INDEX.write_text(html, encoding="utf-8")
    PRIVATE.parent.mkdir(exist_ok=True)
    PRIVATE.write_text(json.dumps(store, ensure_ascii=False, indent=1), encoding="utf-8")

    # بناء ملف الـ Worker الجاهز للصق
    src = WORKER_SRC.read_text(encoding="utf-8")
    if MARK not in src:
        sys.exit("لم أجد علامة /*__PRIVATE_CHANNELS__*/ في worker/hls-proxy.js")
    compact = {k: {"url": v["url"], "type": v.get("type", ""), "mode": v.get("mode", "direct")} for k, v in store.items()}
    WORKER_OUT.parent.mkdir(exist_ok=True)
    WORKER_OUT.write_text(src.replace(MARK, json.dumps(compact, ensure_ascii=False, separators=(",", ":"))), encoding="utf-8")

    modes = {}
    for v in store.values():
        modes[v["mode"]] = modes.get(v["mode"], 0) + 1
    print(f"تم: {stats['new']} جديدة، {stats['reused']} معاد استعمالها، المجموع {len(store)}  {modes}")
    print(f"→ {PRIVATE.relative_to(ROOT)}   (سرّي — لا يُرفع)")
    print(f"→ {WORKER_OUT.relative_to(ROOT)}   (الصقه في Cloudflare ← Edit code ← Deploy)")


if __name__ == "__main__":
    main()
