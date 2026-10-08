#!/usr/bin/env python3
"""
update_streams.py - يستخرج رابط .m3u8 (مع الـ token) لكل قناة معرّفة في config/channels.json
ويحفظه في streams/<id>.json.

الفكرة:
  * يفتح كل صفحة قناة في Chromium (Playwright) وينفّذ JavaScript الخاص بها.
  * يراقب كل طلبات الشبكة (request/response) بحثًا عن HLS (.m3u8 / mpegurl).
  * يختار أرجح رابط بث رئيسي، ويتحقق منه، ثم يكتبه كما هو (بدون تعديل الـ token).
  * عند الفشل يُبقي الرابط القديم كما هو ولا يمس بقية القنوات.
  * لا يكتب الملف إلا إذا تغيّر الرابط (لا commits غير ضرورية).

أمثلة:
  python scripts/update_streams.py                 # تحديث ذكي (يتخطى الروابط الصالحة)
  python scripts/update_streams.py --force         # إعادة الاستخراج للجميع
  python scripts/update_streams.py --only alfajertv1,alfajertv3
  python scripts/update_streams.py --dry-run       # بدون كتابة أي ملف

كود الخروج: 0 = على الأقل قناة واحدة سليمة/محدّثة، 1 = فشلت كل القنوات، 2 = خطأ في الإعدادات.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "channels.json"
DEFAULT_STREAMS_DIR = ROOT / "streams"

# ----------------------------------------------------------------------------
# إعدادات قابلة للتعديل (أو عبر متغيرات البيئة)
# ----------------------------------------------------------------------------
def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


NAV_TIMEOUT_MS = _env_int("PITA_NAV_TIMEOUT_MS", 45_000)      # مهلة فتح الصفحة
WAIT_SECONDS = _env_int("PITA_WAIT_SECONDS", 45)               # أقصى انتظار لظهور m3u8
GRACE_SECONDS = _env_int("PITA_GRACE_SECONDS", 4)              # مهلة إضافية لجمع بقية الروابط
ATTEMPTS = _env_int("PITA_ATTEMPTS", 2)                        # عدد المحاولات لكل قناة
REFRESH_BEFORE_EXPIRY_MIN = _env_int("PITA_REFRESH_BEFORE_EXPIRY_MIN", 25)   # التوكن الفعلي ~30 دقيقة
MAX_AGE_MIN = _env_int("PITA_MAX_AGE_MIN", 120)                # أقصى عمر للرابط قبل إجبار التحديث

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# روابط ليست بثًا رئيسيًا
NON_STREAM_EXT = (".vtt", ".srt", ".ts", ".m4s", ".mp4", ".aac", ".jpg", ".jpeg", ".png", ".gif",
                  ".webp", ".svg", ".css", ".js", ".json", ".key", ".woff", ".woff2")
BAD_WORDS = ("subtitle", "subs", "caption", "thumb", "preview", "poster", "trailer", "advert",
             "/ads/", "ads.", "adserver", "vast", "doubleclick", "analytics")
GOOD_NAMES = ("mono", "index", "master", "playlist", "main", "live", "stream", "manifest")
CHILD_NAMES = ("chunklist", "media_", "audio", "video_", "segment", "frag")

M3U8_IN_TEXT = re.compile(r"""https?:(?:\\?/){2}[^\s"'<>\\()]+?\.m3u8(?:\?[^\s"'<>\\()]*)?""", re.I)

PLAY_SELECTORS = (
    ".jw-icon-display", ".vjs-big-play-button", ".plyr__control--overlaid", ".play-button",
    "button[aria-label*='play' i]", "[class*='play' i][role='button']", "#play", ".play",
    "video",
)


# ----------------------------------------------------------------------------
# أدوات مساعدة
# ----------------------------------------------------------------------------
def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def in_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


def log(msg: str = "") -> None:
    print(msg, flush=True)


def annotate(level: str, title: str, msg: str) -> None:
    """يظهر كتحذير/خطأ ملوّن في صفحة تشغيل GitHub Actions."""
    if in_actions():
        print(f"::{level} title={title}::{msg}", flush=True)
    else:
        print(f"[{level.upper()}] {title}: {msg}", flush=True)


def atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def mask(url: str) -> str:
    """يخفي قيمة الـ token في الـ logs (الرابط الكامل يُحفظ في JSON فقط)."""
    p = urlparse(url)
    q = "?…" if p.query else ""
    return f"{p.scheme}://{p.netloc}{p.path}{q}"


# ----------------------------------------------------------------------------
# الإعدادات والملفات
# ----------------------------------------------------------------------------
class ConfigError(Exception):
    pass


def load_channels(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"ملف الإعدادات غير موجود: {path}")
    except json.JSONDecodeError as exc:
        raise ConfigError(f"ملف الإعدادات ليس JSON صالحًا ({path}): {exc}")

    if not isinstance(data, list) or not data:
        raise ConfigError("channels.json يجب أن يكون قائمة (Array) غير فارغة")

    seen: set[str] = set()
    channels: list[dict] = []
    for i, ch in enumerate(data, 1):
        if not isinstance(ch, dict):
            raise ConfigError(f"العنصر رقم {i} ليس كائنًا")
        cid, name, url = ch.get("id"), ch.get("name"), ch.get("url")
        if not isinstance(cid, str) or not ID_RE.match(cid):
            raise ConfigError(f"العنصر رقم {i}: id غير صالح (حروف صغيرة/أرقام/-/_ فقط): {cid!r}")
        if cid in seen:
            raise ConfigError(f"id مكرر: {cid}")
        seen.add(cid)
        if not isinstance(name, str) or not name.strip():
            raise ConfigError(f"{cid}: الاسم (name) مفقود")
        parsed = urlparse(url) if isinstance(url, str) else None
        if not parsed or parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ConfigError(f"{cid}: رابط الصفحة (url) غير صالح: {url!r}")
        if ch.get("enabled", True) is False:
            continue
        alts = ch.get("alt_urls") or []
        if not isinstance(alts, list) or any(
            not isinstance(a, str) or urlparse(a).scheme not in ("http", "https") for a in alts
        ):
            raise ConfigError(f"{cid}: alt_urls يجب أن تكون قائمة روابط http(s)")
        channels.append({"id": cid, "name": name.strip(), "url": url.strip(), "alt_urls": [a.strip() for a in alts]})
    return channels


def read_stream_file(path: Path) -> dict | None:
    """يقرأ ملف القناة الحالي. أي خلل (غير موجود/JSON تالف) = None."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, OSError) as exc:
        annotate("warning", "JSON تالف", f"{path.name}: {exc} - سيُعاد إنشاؤه")
        return None


# ----------------------------------------------------------------------------
# منطق الـ token / الصلاحية
# ----------------------------------------------------------------------------
_TS_RE = re.compile(r"(?<!\d)(\d{13}|\d{10})(?!\d)")


def parse_expiry(url: str, now: dt.datetime | None = None) -> dt.datetime | None:
    """
    يحاول استنتاج وقت انتهاء الرابط من أرقام Unix timestamp داخل الرابط
    (مثل ...-1726182349-1726171549 أو expires/1787948512891). يرجع أكبر قيمة معقولة.
    """
    now = now or now_utc()
    lo = (now - dt.timedelta(days=30)).timestamp()
    hi = (now + dt.timedelta(days=30)).timestamp()
    p = urlparse(url)
    best = None
    for m in _TS_RE.finditer(p.path + "?" + p.query):
        v = int(m.group(1))
        if len(m.group(1)) == 13:
            v //= 1000
        if lo <= v <= hi and (best is None or v > best):
            best = v
    return dt.datetime.fromtimestamp(best, dt.timezone.utc) if best else None


def is_still_fresh(existing: dict | None, now: dt.datetime) -> tuple[bool, str]:
    """هل الرابط المخزّن ما زال صالحًا لفترة كافية فنتخطى إعادة الاستخراج؟"""
    if not existing:
        return False, "لا يوجد رابط محفوظ"
    url = existing.get("stream_url")
    if not isinstance(url, str) or not url:
        return False, "لا يوجد رابط محفوظ"

    try:
        updated = dt.datetime.fromisoformat(str(existing.get("updated_at")).replace("Z", "+00:00"))
        age_min = (now - updated).total_seconds() / 60
        if age_min >= MAX_AGE_MIN:
            return False, f"عمر الرابط {int(age_min)} دقيقة (الحد {MAX_AGE_MIN})"
    except (ValueError, TypeError):
        return False, "updated_at غير معروف"

    expiry = parse_expiry(url, now)
    if expiry is None:
        return False, "لا يمكن تحديد انتهاء الـ token"
    remaining = (expiry - now).total_seconds() / 60
    if remaining <= REFRESH_BEFORE_EXPIRY_MIN:
        return False, f"يتبقى {int(remaining)} دقيقة فقط على انتهاء الـ token"
    return True, f"الـ token صالح لـ {int(remaining)} دقيقة أخرى (عمر الرابط {int(age_min)} دقيقة)"


# ----------------------------------------------------------------------------
# اختيار رابط البث
# ----------------------------------------------------------------------------
@dataclass
class Candidate:
    url: str
    origin: str                  # request | response | dom
    order: int
    status: int | None = None    # حالة HTTP كما رآها المتصفح
    ctype: str = ""
    probe: str = ""              # نتيجة الفحص الإضافي
    score: int = 0
    notes: list[str] = field(default_factory=list)


def looks_like_hls(url: str, ctype: str = "") -> bool:
    ctype = (ctype or "").lower()
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.netloc:
        return False
    path = p.path.lower()
    if path.endswith(NON_STREAM_EXT):
        return False
    if path.endswith(".m3u8"):
        return True
    return "mpegurl" in ctype  # application/vnd.apple.mpegurl | application/x-mpegURL | audio/mpegurl


def score_candidate(c: Candidate) -> int:
    p = urlparse(c.url)
    path = p.path.lower()
    base = path.rsplit("/", 1)[-1]
    s = 0
    if p.query:
        s += 10
        keys = {k.lower() for k, _ in parse_qsl(p.query, keep_blank_values=True)}
        if keys & {"token", "tok", "key", "sig", "signature", "hash", "auth", "expires", "e", "t"}:
            s += 40                      # يحمل token → غالبًا الرابط الحقيقي
    if any(base.startswith(n) for n in GOOD_NAMES):
        s += 20
    if any(base.startswith(n) for n in CHILD_NAMES):
        s -= 15
    low = c.url.lower()
    if any(w in low for w in BAD_WORDS):
        s -= 60
    if "mpegurl" in c.ctype.lower():
        s += 10
    if c.origin in ("dom", "body"):
        s -= 15                          # رابط وُجد في النص فقط ولم يطلبه المتصفح
    if c.status is not None and 200 <= c.status < 300:
        s += 15
    return s


def pick_best(cands: list[Candidate]) -> list[Candidate]:
    """يرتّب الروابط: الأعلى نقاطًا أولًا، وعند التعادل الأحدث (token أطزج)."""
    for c in cands:
        c.score = score_candidate(c)
    eligible = [c for c in cands if c.status is None or 200 <= c.status < 300]
    return sorted(eligible, key=lambda c: (c.score, c.order), reverse=True)


def validate_stream_url(url: str) -> str | None:
    """يرجع سبب الرفض أو None إذا كان الرابط مقبولًا."""
    if not isinstance(url, str) or not url.strip():
        return "الرابط فارغ"
    if url != url.strip() or re.search(r"\s", url):
        return "الرابط يحتوي مسافات"
    if len(url) > 4096:
        return "الرابط طويل جدًا"
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.netloc:
        return "الرابط ليس http(s) صالحًا"
    if ".m3u8" not in url.lower() and "mpegurl" not in url.lower():
        return "ليس رابط HLS"
    return None


# ----------------------------------------------------------------------------
# الاستخراج عبر Playwright
# ----------------------------------------------------------------------------
class Extractor:
    def __init__(self, pw, headless: bool = True):
        self.pw = pw
        self.headless = headless
        self.browser = None
        self.last_diag: dict = {}

    def _launch(self):
        kwargs = {
            "headless": self.headless,
            "args": [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--autoplay-policy=no-user-gesture-required",
                "--mute-audio",
                "--disable-blink-features=AutomationControlled",
            ],
        }
        exe = os.environ.get("CHROMIUM_PATH")
        if exe:
            kwargs["executable_path"] = exe
        self.browser = self.pw.chromium.launch(**kwargs)

    def ensure_browser(self):
        if self.browser is None or not self.browser.is_connected():
            self._launch()

    def close(self):
        try:
            if self.browser:
                self.browser.close()
        except Exception:
            pass

    # ---- محاولة واحدة ----
    def attempt(self, channel: dict) -> tuple[str | None, str, list[Candidate]]:
        """يرجع (الرابط, سبب الفشل إن وُجد, كل المرشحين)."""
        self.ensure_browser()
        ctx = self.browser.new_context(
            user_agent=USER_AGENT,
            locale="ar",
            viewport={"width": 1280, "height": 720},
            ignore_https_errors=False,
        )
        cands: dict[str, Candidate] = {}
        counter = [0]
        main_status: list[int] = []

        def add(url: str, origin: str, status=None, ctype=""):
            if not looks_like_hls(url, ctype):
                return
            c = cands.get(url)
            if c is None:
                counter[0] += 1
                c = Candidate(url=url, origin=origin, order=counter[0])
                cands[url] = c
            if origin not in ("dom", "body") and c.origin in ("dom", "body"):
                c.origin = origin
            if status is not None:
                c.status = status
            if ctype:
                c.ctype = ctype

        page = None
        ok_result = [False]
        reqlog: list[tuple[str, str]] = []
        bodies: list = []
        self.last_diag = {}
        try:
            ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
            ctx.set_default_timeout(NAV_TIMEOUT_MS)

            def on_request(req):
                try:
                    if len(reqlog) < 400:
                        reqlog.append((req.resource_type, req.url))
                    add(req.url, "request")
                except Exception:
                    pass

            def on_response(resp):
                try:
                    ct = resp.headers.get("content-type", "")
                    add(resp.url, "response", resp.status, ct)
                    if (resp.request.resource_type in ("xhr", "fetch", "document", "script", "other")
                            and re.search(r"json|text|javascript|xml|html", ct, re.I) and len(bodies) < 60):
                        bodies.append(resp)
                    if resp.request.is_navigation_request() and resp.url == channel["url"]:
                        main_status.append(resp.status)
                except Exception:
                    pass

            ctx.on("request", on_request)
            ctx.on("response", on_response)

            # لا نحتاج الصور/الخطوط ولا مقاطع الفيديو نفسها؛ نريد قوائم التشغيل فقط
            def route_handler(route):
                req = route.request
                path = urlparse(req.url).path.lower()
                if req.resource_type in ("image", "font") or path.endswith((".ts", ".m4s", ".aac", ".mp4")):
                    return route.abort()
                return route.continue_()

            ctx.route("**/*", route_handler)

            page = ctx.new_page()
            try:
                resp = page.goto(channel["url"], wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                main_status.append(resp.status if resp is not None else 0)
                if resp is not None and resp.status >= 400:
                    return None, f"الصفحة أعادت HTTP {resp.status}", []
            except Exception as exc:  # timeout / net::ERR_*
                msg = str(exc).splitlines()[0][:160]
                if not cands:
                    return None, f"فشل فتح الصفحة: {msg}", []

            deadline = time.time() + WAIT_SECONDS
            first_seen: float | None = None
            last_poke = 0.0
            while time.time() < deadline:
                now = time.time()
                if cands and first_seen is None:
                    first_seen = now
                if first_seen is not None and now - first_seen >= GRACE_SECONDS:
                    break
                if now - last_poke >= 4:
                    last_poke = now
                    self._poke_players(ctx)
                try:
                    page.wait_for_timeout(500)
                except Exception:
                    break

            # الصفحة تعرض عدة مشغلات (Radian/VideoJS/Clappr/Jw 8/Shaka...): جرّبها بالتتابع
            if not cands:
                self._try_player_buttons(ctx, page, cands)

            # ابحث داخل ردود XHR/JSON (قد يكون الرابط مخفيًا في استجابة API أو بصيغة base64)
            if not cands:
                self._scan_bodies(bodies, add)

            # بحث احتياطي في نص الصفحة والإطارات
            if not cands:
                self._scan_dom(ctx, add)

            if not cands:
                return None, "لم يُعثر على أي رابط .m3u8", []

            ranked = pick_best(list(cands.values()))
            if not ranked:
                bad = ", ".join(sorted({str(c.status) for c in cands.values()}))
                return None, f"روابط m3u8 موجودة لكنها رُفضت من الخادم (HTTP {bad})", list(cands.values())

            # فحص أعلى 3 مرشحين: يجب أن تبدأ القائمة بـ #EXTM3U
            referer = channel["url"]
            origin = f"{urlparse(referer).scheme}://{urlparse(referer).netloc}"
            for c in ranked[:3]:
                try:
                    r = ctx.request.get(
                        c.url,
                        headers={"Referer": referer, "Origin": origin},
                        timeout=20_000,
                        fail_on_status_code=False,
                    )
                    body = r.text()[:2048].lstrip("﻿ \r\n\t")
                    if r.ok and body.startswith("#EXTM3U"):
                        c.probe = "ok"
                    elif r.ok:
                        c.probe = "bad-body"          # 200 لكن ليس قائمة HLS (صفحة خطأ مثلًا)
                    else:
                        c.probe = f"http-{r.status}"
                except Exception as exc:
                    c.probe = "error:" + str(exc).splitlines()[0][:60]

            for c in ranked[:3]:
                if c.probe == "ok":
                    ok_result[0] = True
                    return c.url, "", ranked
            # المتصفح نفسه رأى 2xx لكن الفحص الخارجي لم يعمل (Referer/IP...) → نقبل الأعلى نقاطًا
            for c in ranked[:3]:
                if c.probe != "bad-body" and c.status is not None and 200 <= c.status < 300:
                    c.notes.append("قبول بناءً على استجابة المتصفح فقط")
                    ok_result[0] = True
                    return c.url, "", ranked
            return None, "كل المرشحين فشل فحصهم (" + ", ".join(c.probe for c in ranked[:3]) + ")", ranked
        finally:
            if not ok_result[0]:
                self._snapshot(page, reqlog, main_status)
            try:
                ctx.close()
            except Exception:
                pass

    def _snapshot(self, page, reqlog, main_status) -> None:
        """يحفظ معلومات تشخيصية عن سبب الفشل (تُكتب في debug/ وتظهر في الـ logs)."""
        d: dict = {"http": main_status[:1], "requests": [(t, mask(u)) for t, u in reqlog
                                                         if t not in ("image", "font", "stylesheet")]}
        try:
            if page is not None:
                d["title"] = page.title()
                d["text"] = " ".join(page.inner_text("body", timeout=3000).split())[:400]
                d["html"] = page.content()
                d["png"] = page.screenshot(timeout=5000)
        except Exception:
            pass
        self.last_diag = d

    def _try_player_buttons(self, ctx, page, cands) -> None:
        names = ("Jw 8", "VideoJS", "Clappr", "Radian", "Shaka", "Theo")
        for name in names:
            if cands:
                return
            clicked = False
            for pg in list(ctx.pages):
                for fr in pg.frames:
                    try:
                        loc = fr.get_by_text(name, exact=False).first
                        if loc.count() and loc.is_visible():
                            loc.click(timeout=1500, force=True, no_wait_after=True)
                            clicked = True
                            break
                    except Exception:
                        continue
                if clicked:
                    break
            if clicked:
                log(f"    · جرّبت المشغل: {name}")
                end = time.time() + 7
                while time.time() < end and not cands:
                    self._poke_players(ctx)
                    try:
                        page.wait_for_timeout(700)
                    except Exception:
                        return

    @staticmethod
    def _scan_bodies(bodies, add) -> None:
        b64 = re.compile(r"[A-Za-z0-9+/_-]{40,}={0,2}")
        for r in bodies:
            try:
                txt = r.text()[:600_000]
            except Exception:
                continue
            norm = txt.replace("\\/", "/").replace("\\u0026", "&").replace("&amp;", "&")
            for m in M3U8_IN_TEXT.finditer(norm):
                add(m.group(0).rstrip("\\"), "body")
            for m in list(b64.finditer(txt))[:50]:
                try:
                    import base64
                    raw = m.group(0)
                    dec = base64.b64decode(raw + "=" * (-len(raw) % 4), altchars=b"-_" if ("-" in raw or "_" in raw) else None)
                    t2 = dec.decode("utf-8", errors="ignore")
                except Exception:
                    continue
                for mm in M3U8_IN_TEXT.finditer(t2.replace("\\/", "/")):
                    add(mm.group(0), "body")

    @staticmethod
    def _poke_players(ctx) -> None:
        """يحاول تشغيل المشغل (play) لأن بعض الصفحات لا تطلب m3u8 قبل ذلك."""
        for pg in ctx.pages:
            for fr in pg.frames:
                try:
                    fr.evaluate(
                        "() => document.querySelectorAll('video').forEach(v => { v.muted = true; "
                        "const p = v.play(); if (p && p.catch) p.catch(() => {}); })"
                    )
                except Exception:
                    pass
                for sel in PLAY_SELECTORS:
                    try:
                        el = fr.query_selector(sel)
                        if el and el.is_visible():
                            el.click(timeout=800, no_wait_after=True, force=True)
                            break
                    except Exception:
                        continue

    @staticmethod
    def _scan_dom(ctx, add) -> None:
        for pg in ctx.pages:
            for fr in pg.frames:
                try:
                    html = fr.content()
                except Exception:
                    continue
                txt = html.replace("\\/", "/").replace("\\u0026", "&").replace("&amp;", "&")
                for m in M3U8_IN_TEXT.finditer(txt):
                    add(m.group(0).rstrip("\\"), "dom")


# ----------------------------------------------------------------------------
# التشغيل الرئيسي
# ----------------------------------------------------------------------------
@dataclass
class Result:
    channel: dict
    status: str          # updated | unchanged | fresh | failed | skipped
    detail: str = ""


def write_debug(ex: Extractor, ch: dict, debug_dir: Path | None) -> None:
    d = ex.last_diag or {}
    if d:
        log(f"    تشخيص: HTTP={d.get('http')} العنوان={d.get('title')!r}")
        log(f"    نص الصفحة: {d.get('text', '')[:300]!r}")
        reqs = d.get('requests', [])
        log(f"    عدد الطلبات المسجلة: {len(reqs)}")
        for t, u in reqs[:25]:
            log(f"      - {t:<10} {u}")
    if d and debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        if d.get('html'):
            (debug_dir / f"{ch['id']}-page.html").write_text(d['html'], encoding='utf-8')
        if d.get('png'):
            (debug_dir / f"{ch['id']}.png").write_bytes(d['png'])
        (debug_dir / f"{ch['id']}-requests.txt").write_text(
            '\n'.join(f'{t}\t{u}' for t, u in d.get('requests', [])), encoding='utf-8')


def process_channel(ex: Extractor, ch: dict, streams_dir: Path, force: bool, dry: bool, debug_dir: Path | None = None) -> Result:
    path = streams_dir / f"{ch['id']}.json"
    existing = read_stream_file(path)
    now = now_utc()
    has_old = bool(existing and isinstance(existing.get("stream_url"), str) and existing.get("stream_url"))

    if not force:
        fresh, why = is_still_fresh(existing, now)
        if fresh:
            return Result(ch, "fresh", why)
        log(f"  سبب إعادة الاستخراج: {why}")

    last_reason = "غير معروف"
    url = None
    pages = [ch["url"]] + [a for a in ch.get("alt_urls", []) if a != ch["url"]]
    total = max(ATTEMPTS, len(pages))
    used_page = ch["url"]
    for n in range(1, total + 1):
        used_page = pages[(n - 1) % len(pages)]
        log(f"  محاولة {n}/{total} …  {used_page}")
        try:
            url, reason, cands = ex.attempt(dict(ch, url=used_page))
        except Exception as exc:  # فشل Playwright/المتصفح
            url, reason, cands = None, f"خطأ Playwright: {str(exc).splitlines()[0][:160]}", []
        for c in sorted(cands, key=lambda c: c.score, reverse=True)[:6]:
            log(f"    · [{c.score:>4}] {c.origin:<8} status={c.status} probe={c.probe or '-'} {mask(c.url)}")
        if url:
            bad = validate_stream_url(url)
            if bad:
                url, reason = None, f"الرابط المستخرج مرفوض: {bad}"
        if url:
            break
        last_reason = reason
        log(f"    ✗ {reason}")
        write_debug(ex, ch, debug_dir)
        if "HTTP 404" in reason and len(pages) == 1:
            break  # لا فائدة من إعادة المحاولة

    if not url:
        keep = "تم الاحتفاظ بالرابط القديم" if has_old else "لا يوجد رابط قديم"
        return Result(ch, "failed", f"{last_reason} ({keep})")

    if has_old and existing.get("stream_url") == url:
        return Result(ch, "unchanged", "الرابط مطابق للمحفوظ")

    expiry = parse_expiry(url, now)
    payload = {
        "channel": ch["name"],
        "id": ch["id"],
        "stream_url": url,
        "source_url": used_page,
        "updated_at": iso(now),
        "expires_at": iso(expiry) if expiry else None,
    }
    if not dry:
        atomic_write_json(path, payload)
    return Result(ch, "updated", f"رابط جديد {mask(url)}" + (f" - ينتهي {payload['expires_at']}" if expiry else ""))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--streams-dir", type=Path, default=DEFAULT_STREAMS_DIR)
    ap.add_argument("--only", default="", help="معرّفات مفصولة بفاصلة")
    ap.add_argument("--force", action="store_true", help="تجاهل صلاحية الرابط الحالي وأعد الاستخراج")
    ap.add_argument("--dry-run", action="store_true", help="لا تكتب أي ملف")
    ap.add_argument("--debug-dir", type=Path, default=None, help="مجلد لحفظ لقطة شاشة/HTML/طلبات عند الفشل")
    ap.add_argument("--headful", action="store_true", help="أظهر المتصفح (للتجربة المحلية)")
    args = ap.parse_args(argv)

    try:
        channels = load_channels(args.config)
    except ConfigError as exc:
        annotate("error", "إعدادات خاطئة", str(exc))
        return 2

    if args.only:
        wanted = {x.strip() for x in args.only.split(",") if x.strip()}
        unknown = wanted - {c["id"] for c in channels}
        if unknown:
            annotate("error", "قناة غير معروفة", ", ".join(sorted(unknown)))
            return 2
        channels = [c for c in channels if c["id"] in wanted]

    from playwright.sync_api import sync_playwright  # استيراد متأخر ليعمل --help بدونه

    results: list[Result] = []
    with sync_playwright() as pw:
        ex = Extractor(pw, headless=not args.headful)
        try:
            for ch in channels:
                log(f"::group::{ch['name']} ({ch['id']})" if in_actions() else f"\n=== {ch['name']} ({ch['id']}) ===")
                try:
                    res = process_channel(ex, ch, args.streams_dir, args.force, args.dry_run, args.debug_dir)
                except Exception as exc:  # لا شيء يوقف بقية القنوات
                    res = Result(ch, "failed", f"خطأ غير متوقع: {exc!r}")
                results.append(res)
                icon = {"updated": "✅", "unchanged": "➖", "fresh": "🟢", "failed": "❌"}.get(res.status, "?")
                log(f"  {icon} {res.status}: {res.detail}")
                if in_actions():
                    log("::endgroup::")
                if res.status == "failed":
                    annotate("warning", f"فشل استخراج {ch['name']}", res.detail)
        finally:
            ex.close()

    # ملخص
    log("\n──────── الملخص ────────")
    for r in results:
        log(f"{r.status:<10} {r.channel['id']:<14} {r.detail}")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        try:
            with open(summary, "a", encoding="utf-8") as f:
                f.write("### نتيجة تحديث القنوات\n\n| القناة | الحالة | التفاصيل |\n|---|---|---|\n")
                for r in results:
                    f.write(f"| {r.channel['name']} | {r.status} | {r.detail} |\n")
        except OSError:
            pass

    ok = [r for r in results if r.status != "failed"]
    if not ok:
        annotate("error", "فشلت كل القنوات", "راجع الـ logs: قد يكون الموقع المصدر تغيّر أو حظر الاتصال")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
