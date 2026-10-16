#!/usr/bin/env python3
"""
extract.py - مستخرج روابط البث القابل للتوسّع (نظام مُحوّلات المصادر).

الفكرة:
  * بدل كتابة كود لكل منصة، نكتب مستخرجًا واحدًا يعمل بخط أنابيب ويُوجَّه من الإعدادات.
  * إضافة منصة جديدة من نوع مدعوم = عنصر جديد في config/sources.json فقط، دون تعديل أي كود.
  * النتيجة تُكتب بنفس مخطط قنوات الفجر تمامًا، فتستهلكها نفس صفحات المشغل.

خط الأنابيب:
  1) الجلب        : تحميل صفحة المصدر + ملفات JS الخاصة بها (بدون متصفح).
  2) جمع الحمولات : نص الصفحة + السكربتات المضمّنة + السكربتات الخارجية + أي JSON.
  3) المحلّلات    : مصفوفة كائنات JS -> JSON -> روابط m3u8 عارية -> base64.
  4) الترجيح      : إعادة استخدام score_candidate من update_streams.py.
  5) التطبيع      : سجل قناة موحّد {channel,id,stream_url,source_url,updated_at,expires_at}.
  6) الكتابة      : ذرّية، وفقط عند تغيّر الرابط.

أنواع المصادر (kind):
  auto    - خط الأنابيب أعلاه (الافتراضي، بدون متصفح).
  direct  - رابط .m3u8 جاهز مكتوب في config/sports.json.
  browser - للصفحات التي تُنشئ الروابط عبر JavaScript (يُخدَم بمستخرج الفجر المنفصل).

أمثلة:
  python scripts/extract.py --list                 # اعرض القنوات المكتشفة في كل منصة
  python scripts/extract.py --dry-run              # بدون كتابة أي ملف
  python scripts/extract.py --only sport1,sport7
  python scripts/extract.py --force                # تجاهل الفحص وأعد الاستخراج

كود الخروج: 0 = نجح شيء على الأقل، 1 = فشلت كل القنوات، 2 = خطأ في الإعدادات.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qsl, urljoin, urlparse

# نستورد أدوات موجودة بدل تكرارها (نفس مجلد السكربت)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from update_streams import (  # noqa: E402
    Candidate,
    ConfigError,
    annotate,
    atomic_write_json,
    in_actions,
    iso,
    log,
    mask,
    now_utc,
    parse_expiry,
    score_candidate,
    validate_stream_url,
)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCES = ROOT / "config" / "sources.json"
DEFAULT_SPORTS = ROOT / "config" / "sports.json"
DEFAULT_STREAMS_DIR = ROOT / "streams"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
FETCH_TIMEOUT = 25
MAX_SCRIPT_BYTES = 3_000_000
MAX_SCRIPTS = 30

# حقول افتراضية نبحث عنها داخل عناصر مصفوفة القنوات
DEFAULT_URL_FIELDS = ("url", "stream", "stream_url", "hls", "m3u8", "src", "link", "source", "playback")
DEFAULT_NAME_FIELDS = ("name", "title", "label", "channel")
DEFAULT_ID_FIELDS = ("id", "key", "slug", "channel_id", "num", "number")

M3U8_RE = re.compile(r"""https?://[^\s"'<>\\()\]]+?\.m3u8[^\s"'<>\\()\]]*""", re.I)
B64_RE = re.compile(r"[A-Za-z0-9+/_-]{40,}={0,2}")


# ----------------------------------------------------------------------------
# أدوات نصية: تفكيك حرفي JavaScript إلى JSON
# ----------------------------------------------------------------------------
def _skip_string(text: str, i: int) -> int:
    """يتخطى سلسلة نصية (بدأت عند i) ويرجع الفهرس بعد علامة الإغلاق."""
    quote = text[i]
    i += 1
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch == quote:
            return i + 1
        i += 1
    return n


def _match_bracket(text: str, start: int) -> int:
    """يرجع فهرس `]` المطابق لـ `[` عند start، أو -1."""
    depth = 0
    i = start
    n = len(text)
    while i < n:
        c = text[i]
        if c in "\"'`":
            i = _skip_string(text, i)
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _strip_comments(text: str) -> str:
    """يحذف تعليقات // و /* */ مع احترام السلاسل النصية."""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in "\"'`":
            j = _skip_string(text, i)
            out.append(text[i:j])
            i = j
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] not in "\r\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


_IDENT_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "/": "/",
            "\\": "\\", "'": "'", '"': '"', "`": "`"}


def js_literal_to_json(text: str) -> str:
    """
    يحوّل حرفي JavaScript (مفاتيح بلا اقتباس، اقتباس مفرد، فواصل زائدة، تعليقات)
    إلى JSON صالح. يعيد النص كما هو عند الفشل (سيُرفض لاحقًا في json.loads).
    """
    text = _strip_comments(text)
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in "\"'":
            quote = c
            buf: list[str] = []
            i += 1
            while i < n:
                ch = text[i]
                if ch == "\\" and i + 1 < n:
                    nxt = text[i + 1]
                    if nxt in _ESCAPES:
                        buf.append(_ESCAPES[nxt])
                        i += 2
                        continue
                    if nxt == "u" and i + 5 < n:
                        try:
                            buf.append(chr(int(text[i + 2:i + 6], 16)))
                            i += 6
                            continue
                        except ValueError:
                            pass
                    buf.append(nxt)
                    i += 2
                    continue
                if ch == quote:
                    i += 1
                    break
                buf.append(ch)
                i += 1
            out.append(json.dumps("".join(buf)))
            continue
        if c == "`":
            # سلاسل القوالب: نحتفظ بمحتواها الخام (قد يحتوي رابطًا ثابتًا)
            j = _skip_string(text, i)
            out.append(json.dumps(text[i + 1:j - 1]))
            i = j
            continue
        m = _IDENT_RE.match(text, i)
        if m:
            j = m.end()
            k = j
            while k < n and text[k] in " \t\r\n":
                k += 1
            if k < n and text[k] == ":":
                out.append(json.dumps(m.group(0)))   # مفتاح بلا اقتباس
                i = j
                continue
            out.append(m.group(0))
            i = j
            continue
        out.append(c)
        i += 1

    s = "".join(out)
    s = re.sub(r"\bundefined\b", "null", s)
    s = re.sub(r"\bNaN\b", "null", s)
    s = re.sub(r",(\s*[\]}])", r"\1", s)             # فواصل زائدة
    return s


def _iter_array_regions(text: str):
    """يمر على كل مصفوفة `[...]` في النص ويرجع (بداية, نهاية)."""
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in "\"'`":
            i = _skip_string(text, i)
            continue
        if c == "[":
            end = _match_bracket(text, i)
            if end != -1:
                yield i, end
                i = end + 1
                continue
        i += 1


# ----------------------------------------------------------------------------
# القبول والترجيح
# ----------------------------------------------------------------------------
def is_streamish(url: str) -> bool:
    """هل يبدو الرابط بثًّا؟ (يشمل روابط البروكسي التي تخفي m3u8 داخل ?u=)"""
    if not isinstance(url, str) or not url.strip():
        return False
    low = url.lower()
    if ".m3u8" in low or "mpegurl" in low:
        return True
    p = urlparse(url)
    for _, v in parse_qsl(p.query, keep_blank_values=True):
        vv = v.lower()
        if ".m3u8" in vv or "mpegurl" in vv:
            return True
    return False


@dataclass
class Found:
    url: str
    name: str = ""
    chan_id: str = ""
    origin: str = ""
    order: int = 0
    score: int = 0
    note: str = ""


def score_found(f: Found, structured: bool) -> int:
    """يرجّح مرشّحًا بإعادة استخدام منطق الترجيح المشترك + مكافأة الروابط المنظّمة."""
    c = Candidate(url=f.url, origin="dom" if f.origin.startswith("dom") else "body", order=f.order)
    s = score_candidate(c)
    if structured:
        s += 50          # جاء من مصفوفة قنوات منظّمة (اسم/معرّف معروفان)
    if is_streamish(f.url):
        s += 10
    return s


# ----------------------------------------------------------------------------
# الجلب وجمع الحمولات
# ----------------------------------------------------------------------------
def fetch(url: str, timeout: int = FETCH_TIMEOUT) -> tuple[str, str]:
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "ar,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read(MAX_SCRIPT_BYTES)
        ctype = r.headers.get("content-type", "")
    return raw.decode("utf-8", errors="replace"), ctype


def probe_stream(url: str, timeout: int = 12, attempts: int = 2) -> tuple[bool, str]:
    """
    فحص صحة رابط بث فعليًا: نقرأ أول بايتات فقط ثم نقطع الاتصال.
    (بعض الخوادم لا تدعم Range، فلا ننتظر تحميل القائمة كاملة.)
    نعيد المحاولة عند الفشل الشبكي العابر حتى لا نرفض قناة سليمة بسبب هفوة.
    يرجع (سليم؟, تفصيل).
    """
    why = "غير معروف"
    for n in range(1, max(1, attempts) + 1):
        req = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                head = r.read(2048)
                ctype = (r.headers.get("content-type") or "").lower()
        except urllib.error.HTTPError as exc:
            # أخطاء الحالة حاسمة (404/403…) — لا فائدة من الإعادة
            return False, f"HTTP {exc.code}"
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            why = f"تعذّر الاتصال: {str(exc).splitlines()[0][:80]}"
            if n < attempts:
                time.sleep(1.5)
                continue
            return False, why

        text = head.decode("utf-8", errors="replace").lstrip("﻿ \r\n\t")
        if text.startswith("#EXTM3U"):
            return True, "سليم"
        if "mpegurl" in ctype:
            return True, "سليم (نوع mpegurl)"
        why = f"المحتوى ليس قائمة HLS ({text[:40]!r})"
        if n < attempts:
            time.sleep(1.5)
            continue
        return False, why
    return False, why


def collect_payloads(page_url: str, html: str, hints: dict) -> list[tuple[str, str]]:
    """
    يجمع كل الحمولات المرشّحة: نص الصفحة + السكربتات المضمّنة + السكربتات الخارجية
    (المُشار إليها في hints أولًا، ثم سكربتات نفس الأصل).
    """
    payloads: list[tuple[str, str]] = [(page_url, html)]
    page_netloc = urlparse(page_url).netloc.lower()
    wanted = [s.lower() for s in (hints.get("scripts") or [])]

    inline: list[tuple[str, str]] = []
    external: list[tuple[str, str]] = []   # (url, attrs)
    for m in re.finditer(r"<script\b([^>]*)>(.*?)</script\s*>", html, re.S | re.I):
        attrs, body = m.group(1), m.group(2)
        if body.strip():
            inline.append((page_url, body))
        src = re.search(r"""src\s*=\s*["']([^"']+)["']""", attrs, re.I)
        if src:
            external.append((urljoin(page_url, src.group(1).strip()), attrs))

    payloads.extend(inline)

    def priority(item: tuple[str, str]) -> int:
        u = item[0].lower()
        return 0 if any(w in u for w in wanted) else 1

    fetched = 0
    for u, _attrs in sorted(external, key=priority):
        if fetched >= MAX_SCRIPTS:
            break
        same_origin = urlparse(u).netloc.lower() == page_netloc
        is_hinted = any(w in u.lower() for w in wanted)
        if not (same_origin or is_hinted):
            continue
        try:
            body, _ = fetch(u)
        except Exception as exc:
            log(f"    · تعذّر جلب {mask(u)}: {str(exc).splitlines()[0][:80]}")
            continue
        payloads.append((u, body))
        fetched += 1
    return payloads


# ----------------------------------------------------------------------------
# المحلّلات
# ----------------------------------------------------------------------------
def parse_channel_arrays(payloads, hints) -> list[Found]:
    """يبحث عن مصفوفة كائنات JS تشبه قائمة قنوات (اسم/معرّف/رابط بث)."""
    url_fields = tuple(hints.get("url_fields") or DEFAULT_URL_FIELDS)
    name_fields = tuple(hints.get("name_fields") or DEFAULT_NAME_FIELDS)
    id_fields = tuple(hints.get("id_fields") or DEFAULT_ID_FIELDS)
    array_keys = [k.lower() for k in (hints.get("array_keys") or [])]

    found: list[Found] = []
    order = 0
    for src, text in payloads:
        for start, end in _iter_array_regions(text):
            # نتجاهل المصفوفات التي لا تبدأ بكائن
            head = text[start + 1:start + 40].lstrip()
            if not head.startswith("{"):
                continue
            raw = text[start:end + 1]
            try:
                items = json.loads(js_literal_to_json(raw))
            except (json.JSONDecodeError, ValueError):
                continue
            if not isinstance(items, list) or not items:
                continue
            dicts = [it for it in items if isinstance(it, dict)]
            if len(dicts) < max(1, len(items) // 2):
                continue

            hits = 0
            for it in dicts:
                if any(isinstance(it.get(f), str) and is_streamish(it[f]) for f in url_fields):
                    hits += 1
            if hits == 0:
                continue
            # نتحقق من تلميح اسم المصفوفة (إن وُجد) لزيادة الدقة
            if array_keys:
                ctx = text[max(0, start - 120):start].lower()
                if not any(k in ctx for k in array_keys) and hits < len(dicts):
                    continue

            for it in dicts:
                url = next((it[f] for f in url_fields
                            if isinstance(it.get(f), str) and is_streamish(it[f])), None)
                if not url:
                    continue
                name = next((str(it[f]) for f in name_fields if it.get(f)), "")
                cid = next((str(it[f]) for f in id_fields if it.get(f) is not None), "")
                order += 1
                found.append(Found(url=url.strip(), name=name.strip(), chan_id=cid.strip(),
                                   origin="array", order=order,
                                   note=f"من مصفوفة في {Path(urlparse(src).path).name or 'الصفحة'}"))
    return found


def parse_json_blobs(payloads, hints) -> list[Found]:
    """يبحث عن أي JSON صالح يحتوي روابط بث (مصفوفة أو كائن)."""
    url_fields = tuple(hints.get("url_fields") or DEFAULT_URL_FIELDS)
    found: list[Found] = []
    order = 1000
    for _src, text in payloads:
        t = text.strip()
        if not (t.startswith("[") or t.startswith("{")):
            continue
        try:
            data = json.loads(t)
        except (json.JSONDecodeError, ValueError):
            continue

        def walk(node):
            nonlocal order
            if isinstance(node, dict):
                url = next((node[f] for f in url_fields
                            if isinstance(node.get(f), str) and is_streamish(node[f])), None)
                if url:
                    order += 1
                    name = next((str(node[f]) for f in DEFAULT_NAME_FIELDS if node.get(f)), "")
                    cid = next((str(node[f]) for f in DEFAULT_ID_FIELDS if node.get(f) is not None), "")
                    found.append(Found(url=url.strip(), name=name.strip(), chan_id=cid.strip(),
                                       origin="json", order=order, note="من JSON صالح"))
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        walk(data)
    return found


def parse_regex_hls(payloads) -> list[Found]:
    """يبحث عن روابط m3u8 عارية في النص."""
    found: list[Found] = []
    order = 2000
    for src, text in payloads:
        norm = text.replace("\\/", "/").replace("\\u0026", "&").replace("&amp;", "&")
        for m in M3U8_RE.finditer(norm):
            order += 1
            found.append(Found(url=m.group(0).rstrip("\\,;"), origin="dom", order=order,
                               note=f"رابط عارٍ في {Path(urlparse(src).path).name or 'الصفحة'}"))
    return found


def parse_base64(payloads) -> list[Found]:
    """يفكّ ترميز blobs الـ base64 ثم يعيد تشغيل محلّل الروابط العارية عليها."""
    found: list[Found] = []
    order = 3000
    for src, text in payloads:
        for m in list(B64_RE.finditer(text))[:80]:
            raw = m.group(0)
            try:
                alt = b"-_" if ("-" in raw or "_" in raw) else None
                dec = base64.b64decode(raw + "=" * (-len(raw) % 4), altchars=alt)
                t2 = dec.decode("utf-8", errors="ignore")
            except Exception:
                continue
            for mm in M3U8_RE.finditer(t2.replace("\\/", "/")):
                order += 1
                found.append(Found(url=mm.group(0), origin="body", order=order,
                                   note=f"مفكوك من base64 في {Path(urlparse(src).path).name or 'الصفحة'}"))
    return found


# ----------------------------------------------------------------------------
# المُحوّلات
# ----------------------------------------------------------------------------
def extract_auto(source: dict) -> list[Found]:
    """المحوّل الافتراضي: يجلب الصفحة ويشغّل كل المحلّلات عليها."""
    page = source["page"]
    hints = source.get("hints") or {}
    log(f"  جلب: {page}")
    html, _ctype = fetch(page)
    payloads = collect_payloads(page, html, hints)
    log(f"    · عدد الحمولات: {len(payloads)}")

    structured = parse_channel_arrays(payloads, hints) + parse_json_blobs(payloads, hints)
    if not structured:
        # لا توجد بنية منظّمة -> نلجأ للمحلّلات النصية
        structured = parse_regex_hls(payloads) + parse_base64(payloads)
    else:
        # نضيف النصية أيضًا كاحتياط، لكن بترجيح أقل (بدون مكافأة البنية)
        structured = structured + parse_regex_hls(payloads) + parse_base64(payloads)

    # إزالة التكرار مع الحفاظ على أول ظهور (الأعلى ترتيبًا)
    seen: dict[str, Found] = {}
    for f in structured:
        if f.url not in seen:
            seen[f.url] = f
    unique = list(seen.values())
    for f in unique:
        f.score = score_found(f, structured=f.origin in ("array", "json"))
    unique.sort(key=lambda f: (f.score, -f.order), reverse=True)

    # فحص صحة أعلى المرشّحين فقط (نمنع كتابة روابط ميّتة مثل قناة ميتة في المصدر)
    for f in unique[:8]:
        ok, why = probe_stream(f.url)
        f.note = f"{f.note} · {'✅' if ok else '✗'} {why}".strip(" ·")
        if not ok:
            f.score -= 500
    unique.sort(key=lambda f: (f.score, -f.order), reverse=True)
    return unique


def channel_page_url(src: dict, sport: dict, pick: Found | None = None) -> str:
    """
    يبني رابط صفحة القناة الواحدة من قالب المصدر (channel_page) إن وُجد،
    وإلا يرجع صفحة المنصة العامة. يدعم {channel} و{id} و{name}.

    يعمل أيضًا بلا `pick` (عند فشل الاستخراج) فيستخدم source_channel واسم القناة،
    لنحصل على رابط الصفحة كحل ثانوي.
    """
    template = (src.get("channel_page") or "").strip()
    if not template:
        return src.get("page") or ""
    values = {
        "channel": sport.get("source_channel"),
        "id": (pick.chan_id if pick else None) or sport.get("source_channel"),
        "name": (pick.name if pick else None) or sport.get("name"),
    }
    out = template
    for key, val in values.items():
        if val is not None:
            out = out.replace("{" + key + "}", str(val).strip())
    return out


def _match_channel(found: list[Found], spec: dict) -> Found | None:
    """يطابق قناة الموقع مع قناة مكتشفة: بالمعرّف، ثم بالاسم، ثم بالترتيب."""
    want_id = spec.get("source_channel")
    if want_id is not None:
        ws = str(want_id).strip().lower()
        for f in found:
            if f.chan_id and f.chan_id.strip().lower() == ws:
                return f
        # تطابق رقمي (1 == "1")
        for f in found:
            try:
                if f.chan_id and int(f.chan_id) == int(want_id):
                    return f
            except (TypeError, ValueError):
                continue
    want_name = (spec.get("source_name") or "").strip().lower()
    if want_name:
        for f in found:
            if want_name in f.name.lower():
                return f
    want_index = spec.get("source_index")
    if want_index is not None and 0 <= int(want_index) < len(found):
        return found[int(want_index)]
    return None


# ----------------------------------------------------------------------------
# الإعدادات
# ----------------------------------------------------------------------------
def load_sources(path: Path) -> dict[str, dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"ملف المصادر غير موجود: {path}")
    except json.JSONDecodeError as exc:
        raise ConfigError(f"ملف المصادر ليس JSON صالحًا ({path}): {exc}")

    items = data.get("sources") if isinstance(data, dict) else data
    if not isinstance(items, list) or not items:
        raise ConfigError("sources.json يجب أن يحتوي قائمة sources غير فارغة")

    out: dict[str, dict] = {}
    for i, s in enumerate(items, 1):
        if not isinstance(s, dict):
            raise ConfigError(f"المصدر رقم {i} ليس كائنًا")
        sid = s.get("id")
        if not isinstance(sid, str) or not ID_RE.match(sid):
            raise ConfigError(f"المصدر رقم {i}: id غير صالح: {sid!r}")
        kind = s.get("kind", "auto")
        if kind not in ("auto", "direct", "browser"):
            raise ConfigError(f"{sid}: kind غير مدعوم: {kind!r} (auto|direct|browser)")
        if kind == "auto":
            page = s.get("page")
            parsed = urlparse(page) if isinstance(page, str) else None
            if not parsed or parsed.scheme not in ("http", "https") or not parsed.netloc:
                raise ConfigError(f"{sid}: page غير صالح: {page!r}")
        out[sid] = s
    return out


def load_sports(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"ملف القنوات غير موجود: {path}")
    except json.JSONDecodeError as exc:
        raise ConfigError(f"ملف القنوات ليس JSON صالحًا ({path}): {exc}")

    if not isinstance(data, list) or not data:
        raise ConfigError("sports.json يجب أن يكون قائمة غير فارغة")

    seen: set[str] = set()
    out: list[dict] = []
    for i, ch in enumerate(data, 1):
        if not isinstance(ch, dict):
            raise ConfigError(f"العنصر رقم {i} ليس كائنًا")
        cid, name = ch.get("id"), ch.get("name")
        if not isinstance(cid, str) or not ID_RE.match(cid):
            raise ConfigError(f"العنصر رقم {i}: id غير صالح: {cid!r}")
        if cid in seen:
            raise ConfigError(f"id مكرر: {cid}")
        seen.add(cid)
        if not isinstance(name, str) or not name.strip():
            raise ConfigError(f"{cid}: الاسم (name) مفقود")
        kind = ch.get("kind", "auto" if ch.get("source") else ("direct" if ch.get("url") else "unconfigured"))
        if kind == "direct":
            u = ch.get("url")
            if not isinstance(u, str) or urlparse(u).scheme not in ("http", "https"):
                raise ConfigError(f"{cid}: kind=direct يحتاج رابط url صالحًا")
        elif kind == "auto":
            if not isinstance(ch.get("source"), str):
                raise ConfigError(f"{cid}: يحتاج حقل source")
        out.append({**ch, "id": cid, "name": name.strip(), "kind": kind})
    return out


# ----------------------------------------------------------------------------
# التشغيل الرئيسي
# ----------------------------------------------------------------------------
@dataclass
class Result:
    channel: dict
    status: str          # updated | unchanged | failed | skipped | unconfigured
    detail: str = ""


def write_debug(debug_dir: Path | None, cid: str, found: list[Found], payloads: list[tuple[str, str]]) -> None:
    if not debug_dir:
        return
    debug_dir.mkdir(parents=True, exist_ok=True)
    lines = [f"{f.score:>5}  {f.origin:<8} {f.chan_id:<6} {f.name:<24} {mask(f.url)}" for f in found[:60]]
    (debug_dir / f"{cid}-candidates.txt").write_text("\n".join(lines) or "(لا مرشّحين)", encoding="utf-8")


def fallback_page(sport: dict, sources: dict) -> str:
    """
    رابط الصفحة الذي نعرضه كحل ثانوي عند فشل استخراج رابط البث.

    الأولوية:
      1) fallback_url المكتوب صراحةً في config/sports.json (يفيد القنوات بلا مصدر).
      2) صفحة القناة الواحدة المبنية من قالب المصدر (channel_page).
      3) صفحة المنصة العامة.
    """
    explicit = (sport.get("fallback_url") or "").strip()
    if explicit:
        return explicit
    src = sources.get(sport.get("source") or "")
    if not src:
        return ""
    return channel_page_url(src, sport, None)


def write_sports_map(sports: list[dict], sources: dict, path: Path, dry: bool) -> None:
    """
    يكتب sports.js: خريطة صغيرة من معرّف القناة إلى صفحتها، تُحمَّل بوسم <script>
    عادي. هذا ما يجعل صفحة المشغل تعرف رابط الصفحة الاحتياطية **دون** أي fetch —
    فيعمل الحل الثانوي حتى عند فتح الموقع ببروتوكول file:// أو عند تعذّر قراءة
    streams/<id>.json لأي سبب. تُبنى من نفس منطق fallback_page فلا تتباعد النسختان.
    """
    rows = []
    for s in sports:
        page = fallback_page(s, sources)
        rows.append(f"  {json.dumps(s['id'])}: {json.dumps(page or '', ensure_ascii=False)}")
    body = ",\n".join(rows)
    text = (
        "/* مولَّد آليًا من config/sports.json + config/sources.json — لا تعدّله يدويًا.\n"
        "   غرضه: أن يعرف المشغّل صفحة القناة الاحتياطية بلا fetch (يعمل على file://). */\n"
        "window.SPORTS = {\n" + body + "\n};\n"
    )
    if dry:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_fallback(sport: dict, path: Path, page: str, reason: str, now, dry: bool) -> None:
    """
    يكتب ملف القناة بحالة fallback مع رابط الصفحة، حتى يعرضه المشغل
    بدل رابط بث لم يُستخرج. لا يمسّ أي رابط قديم يعمل (تلك حالة stale).
    """
    payload = {
        "channel": sport["name"], "id": sport["id"], "stream_url": None,
        "source_url": page or None, "updated_at": iso(now), "expires_at": None,
        "status": "fallback",
        "detail": (f"{reason} — يُعرض رابط صفحة القناة كحل ثانوي" if page else reason),
    }
    if not dry:
        atomic_write_json(path, payload)


def process_sport(sport: dict, sources: dict, streams_dir: Path, cache: dict, dry: bool,
                  debug_dir: Path | None) -> Result:
    cid, kind = sport["id"], sport["kind"]
    path = streams_dir / f"{cid}.json"
    now = now_utc()

    # --- قناة بلا مصدر بعد ---
    if kind == "unconfigured":
        page = fallback_page(sport, sources)
        if page:
            write_fallback(sport, path, page, "لا يوجد مصدر مرتبط بعد", now, dry)
            return Result(sport, "unconfigured",
                          f"لا يوجد مصدر مرتبط بعد — يُعرض رابط صفحة القناة كحل ثانوي ({mask(page)})")
        payload = {
            "channel": sport["name"], "id": cid, "stream_url": None, "source_url": None,
            "updated_at": iso(now), "expires_at": None, "status": "unconfigured",
            "detail": "لا يوجد مصدر مرتبط بعد — أضف منصة في config/sources.json ثم اربطها في config/sports.json",
        }
        if not dry:
            atomic_write_json(path, payload)
        return Result(sport, "unconfigured", payload["detail"])

    # --- رابط مباشر ---
    if kind == "direct":
        url = sport["url"]
        page = fallback_page(sport, sources)
        bad = validate_stream_url(url)
        if bad:
            write_fallback(sport, path, page, f"رابط مباشر مرفوض ({bad})", now, dry)
            return Result(sport, "failed", f"رابط مباشر مرفوض: {bad} — الحل الثانوي: {mask(page) or 'لا يوجد'}")
        if path.exists():
            try:
                old = json.loads(path.read_text(encoding="utf-8"))
                if old.get("stream_url") == url and old.get("status") == "ok":
                    return Result(sport, "unchanged", "الرابط مطابق للمحفوظ")
            except (json.JSONDecodeError, OSError):
                pass
        ok, why = probe_stream(url)
        if not ok:
            # نُبقي أي رابط قديم يعمل (حالة stale)، وإلا نعرض صفحة القناة كحل ثانوي
            if path.exists():
                try:
                    old = json.loads(path.read_text(encoding="utf-8"))
                    if old.get("status") == "ok" and old.get("stream_url"):
                        return Result(sport, "stale", f"الرابط المباشر معطّل ({why}) — أُبقي الرابط القديم")
                except (json.JSONDecodeError, OSError):
                    pass
            write_fallback(sport, path, page, f"رابط مباشر معطّل ({why})", now, dry)
            return Result(sport, "failed", f"الرابط المباشر معطّل: {why} — الحل الثانوي: {mask(page) or 'لا يوجد'}")
        payload = {
            "channel": sport["name"], "id": cid, "stream_url": url, "source_url": page or None,
            "updated_at": iso(now), "expires_at": None, "status": "ok", "detail": "رابط مباشر",
        }
        if not dry:
            atomic_write_json(path, payload)
        return Result(sport, "updated", f"رابط مباشر {mask(url)}")

    # --- مستخرج المتصفح (يُدار عبر update_streams.py) ---
    if kind == "browser":
        return Result(sport, "skipped", "يُدار هذا النوع عبر scripts/update_streams.py (مستخرج المتصفح)")

    # --- auto: خط الأنابيب ---
    sid = sport["source"]
    src = sources.get(sid)
    page = fallback_page(sport, sources)
    if src is None:
        write_fallback(sport, path, page, f"المصدر غير معرّف ({sid!r})", now, dry)
        return Result(sport, "failed", f"المصدر غير معرّف في sources.json: {sid!r}")
    if src.get("kind") != "auto":
        write_fallback(sport, path, page, f"نوع المصدر {src.get('kind')!r} وليس auto", now, dry)
        return Result(sport, "failed", f"المصدر {sid!r} نوعه {src.get('kind')!r} وليس auto")

    if sid not in cache:
        try:
            cache[sid] = extract_auto(src)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            cache[sid] = exc
    found = cache[sid]
    if isinstance(found, Exception):
        reason = f"فشل جلب المصدر {sid}: {str(found).splitlines()[0][:140]}"
        write_fallback(sport, path, page, reason, now, dry)
        return Result(sport, "failed", f"{reason} — الحل الثانوي: {mask(page) or 'لا يوجد'}")
    if not found:
        reason = f"لم يُعثر على أي رابط بث في المصدر {sid}"
        write_fallback(sport, path, page, reason, now, dry)
        return Result(sport, "failed", f"{reason} — الحل الثانوي: {mask(page) or 'لا يوجد'}")

    write_debug(debug_dir, cid, found, [])
    pick = _match_channel(found, sport)
    if pick is None:
        reason = (f"لم يُطابق source_channel={sport.get('source_channel')!r} في المصدر {sid} "
                  f"(المتاح: {', '.join(f.chan_id or f.name for f in found[:12])})")
        write_fallback(sport, path, page, reason, now, dry)
        return Result(sport, "failed", f"{reason} — الحل الثانوي: {mask(page) or 'لا يوجد'}")

    bad = validate_stream_url(pick.url)
    if bad:
        write_fallback(sport, path, page, f"الرابط المكتشف مرفوض ({bad})", now, dry)
        return Result(sport, "failed", f"الرابط المكتشف مرفوض: {bad} — الحل الثانوي: {mask(page) or 'لا يوجد'}")

    old: dict = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            old = loaded if isinstance(loaded, dict) else {}
        except (json.JSONDecodeError, OSError):
            old = {}
    old_url = old.get("stream_url")

    if pick.score < 0:
        # بث المصدر ميّت. إن كان لدينا رابط محفوظ يعمل، نبقيه ونسمّي الحالة بوضوح
        # حتى لا يبدو الأمر عطلًا في نظامنا ولا يُطلق تحذيرًا كل دورة.
        if old_url:
            return Result(sport, "stale", f"بث المصدر ميّت ({pick.note}) — أُبقي الرابط المحفوظ")
        page = fallback_page(sport, sources)
        write_fallback(sport, path, page, f"بث المصدر ميّت ({pick.note})", now, dry)
        return Result(sport, "failed",
                      f"بث المصدر ميّت ولا يوجد رابط محفوظ ({pick.note}) — الحل الثانوي: {mask(page) or 'لا يوجد'}")

    source_page = channel_page_url(src, sport, pick)
    if old_url == pick.url and old.get("source_url") == source_page and old.get("status") == "ok":
        return Result(sport, "unchanged", f"الرابط مطابق ({pick.name or pick.chan_id})")

    expiry = parse_expiry(pick.url, now)
    payload = {
        "channel": sport["name"], "id": cid, "stream_url": pick.url,
        "source_url": source_page, "updated_at": iso(now),
        "expires_at": iso(expiry) if expiry else None, "status": "ok",
        "detail": f"{pick.name or ''} · {pick.note}".strip(" ·"),
    }
    if not dry:
        atomic_write_json(path, payload)
    return Result(sport, "updated", f"رابط جديد {mask(pick.url)} ({pick.name or pick.chan_id})")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sources", type=Path, default=DEFAULT_SOURCES)
    ap.add_argument("--sports", type=Path, default=DEFAULT_SPORTS)
    ap.add_argument("--streams-dir", type=Path, default=DEFAULT_STREAMS_DIR)
    ap.add_argument("--only", default="", help="معرّفات قنوات مفصولة بفاصلة")
    ap.add_argument("--force", action="store_true", help="أعد الكتابة حتى لو لم يتغيّر الرابط")
    ap.add_argument("--dry-run", action="store_true", help="لا تكتب أي ملف")
    ap.add_argument("--list", action="store_true", help="اعرض القنوات المكتشفة في كل منصة ثم اخرج")
    ap.add_argument("--debug-dir", type=Path, default=None, help="مجلد لحفظ المرشّحين عند الفشل")
    args = ap.parse_args(argv)

    try:
        sources = load_sources(args.sources)
        sports = load_sports(args.sports)
    except ConfigError as exc:
        annotate("error", "إعدادات خاطئة", str(exc))
        return 2

    all_sports = sports          # القائمة الكاملة — تُبنى منها خريطة الصفحات الاحتياطية
    if args.only:
        wanted = {x.strip() for x in args.only.split(",") if x.strip()}
        unknown = wanted - {c["id"] for c in sports}
        if unknown:
            annotate("error", "قناة غير معروفة", ", ".join(sorted(unknown)))
            return 2
        sports = [c for c in sports if c["id"] in wanted]

    if args.list:
        for sid, src in sources.items():
            if src.get("kind") != "auto":
                log(f"\n=== {sid} ({src.get('kind')}) — يُدار خارجيًا ===")
                continue
            log(f"\n=== {sid}: {src.get('page')} ===")
            try:
                for f in extract_auto(src):
                    log(f"  [{f.score:>5}] id={f.chan_id or '-':<6} {f.name or '-':<24} {mask(f.url)}")
            except Exception as exc:
                log(f"  ✗ {str(exc).splitlines()[0][:140]}")
        return 0

    results: list[Result] = []
    cache: dict[str, object] = {}
    for sport in sports:
        log(f"::group::{sport['name']} ({sport['id']})" if in_actions() else f"\n=== {sport['name']} ({sport['id']}) ===")
        try:
            res = process_sport(sport, sources, args.streams_dir, cache, args.dry_run, args.debug_dir)
        except Exception as exc:
            res = Result(sport, "failed", f"خطأ غير متوقع: {exc!r}")
        results.append(res)
        icon = {"updated": "✅", "unchanged": "➖", "unconfigured": "⚪", "fallback": "↩️",
                "skipped": "⏭️", "stale": "⚠️", "failed": "❌"}.get(res.status, "?")
        log(f"  {icon} {res.status}: {res.detail}")
        if in_actions():
            log("::endgroup::")
        if res.status == "failed":
            annotate("warning", f"فشل {sport['name']}", res.detail)

    # خريطة الصفحات الاحتياطية: تُولَّد دائمًا حتى لو فشلت كل القنوات،
    # لأنها ما يعتمد عليه المشغّل عند تعذّر قراءة ملفات streams.
    write_sports_map(all_sports, sources, ROOT / "sports.js", args.dry_run)
    log("\n📄 sports.js: خريطة صفحات القنوات الاحتياطية (بلا fetch)")

    log("\n──────── الملخص ────────")
    for r in results:
        log(f"{r.status:<12} {r.channel['id']:<10} {r.detail}")

    summary = __import__("os").environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        try:
            with open(summary, "a", encoding="utf-8") as f:
                f.write("### نتيجة تحديث قنوات Sport\n\n| القناة | الحالة | التفاصيل |\n|---|---|---|\n")
                for r in results:
                    f.write(f"| {r.channel['name']} | {r.status} | {r.detail} |\n")
        except OSError:
            pass

    failed = [r for r in results if r.status == "failed"]
    if failed and len(failed) == len(results):
        annotate("error", "فشلت كل القنوات", "راجع الـ logs: قد يكون المصدر تغيّر أو حظر الاتصال")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
