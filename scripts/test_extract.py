#!/usr/bin/env python3
"""
اختبارات وحدة لمحلّلات الاستخراج (scripts/extract.py).

تغطي: تفكيك حرفي JavaScript إلى JSON، اكتشاف مصفوفة القنوات، الترجيح،
قبول روابط البروكسي التي تخفي m3u8 داخل ?u=، فك base64، ومطابقة القنوات.
لا تحتاج شبكة.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract import (  # noqa: E402
    Found,
    _match_channel,
    channel_page_url,
    fallback_page,
    is_streamish,
    js_literal_to_json,
    parse_channel_arrays,
    parse_channel_servers,
    _candidates_for,
    parse_regex_hls,
    score_found,
)

# مقتطف واقعي من app.js لمنصة ALWAN (مفاتيح بلا اقتباس، اقتباس مفرد ومزدوج، تعليق)
ALWAN_JS = """
// قنوات ALWAN
const channels = [
  { id: 1, name: "ALWAN SPORT 1", url: "https://kurdtv.org/api/public/hls?u=https%3A%2F%2Fprod-fastly.example%2Fdynamic_delta.m3u8%3Ftype%3Dlive", type: "hls" },
  { id: 2, name: 'ALWAN SPORT 2', url: 'https://kurdtv.org/api/public/hls?u=https%3A%2F%2Fprod-fastly.example%2Fother.m3u8', type: "hls" },
  { id: 7, name: "ALWAN SPORT 7", url: "http://cdn.example/Beinhdr/index.m3u8", type: "hls" },
];
var other = [1, 2, 3];
"""

PAGE_HTML = """
<html><head><script src="app.js?v=1"></script></head>
<body><script>var encUrl = "aHR0cHM6Ly9jZG4uZXhhbXBsZS9saXZlL21vbm8ubTN1OD9hPTE=";</script></body></html>
"""


class JsLiteralTests(unittest.TestCase):
    def test_unquoted_keys_and_quotes_become_valid_json(self):
        import json
        raw = '[{ id: 1, name: "a", url: \'http://x/y.m3u8\' }]'
        self.assertEqual(
            json.loads(js_literal_to_json(raw)),
            [{"id": 1, "name": "a", "url": "http://x/y.m3u8"}],
        )

    def test_comments_trailing_comma_and_undefined(self):
        import json
        raw = '[{a: 1, /* c */ b: undefined,},]'
        self.assertEqual(json.loads(js_literal_to_json(raw)), [{"a": 1, "b": None}])


class StreamishTests(unittest.TestCase):
    def test_plain_m3u8(self):
        self.assertTrue(is_streamish("http://cdn.example/live/mono.m3u8?t=1"))

    def test_proxy_url_hiding_m3u8_inside_query(self):
        # رابط بروكسي: لا ينتهي بـ .m3u8 لكن ?u= يحتوي عليه → يجب أن يُقبل
        u = "https://kurdtv.org/api/public/hls?u=https%3A%2F%2Fp.example%2Fd.m3u8%3Ftype%3Dlive"
        self.assertTrue(is_streamish(u))

    def test_non_stream_rejected(self):
        self.assertFalse(is_streamish("https://example.com/logo.png"))
        self.assertFalse(is_streamish(""))


class ChannelArrayTests(unittest.TestCase):
    def test_discovers_alwan_array_with_ids_and_names(self):
        found = parse_channel_arrays([("https://alwanlive.stream/app.js", ALWAN_JS)], {})
        self.assertEqual(len(found), 3)
        by_id = {f.chan_id: f for f in found}
        self.assertEqual(by_id["1"].name, "ALWAN SPORT 1")
        self.assertTrue(by_id["1"].url.startswith("https://kurdtv.org/api/public/hls?u="))
        self.assertEqual(by_id["7"].name, "ALWAN SPORT 7")

    def test_ignores_non_channel_arrays(self):
        found = parse_channel_arrays([("x", "var nums = [1,2,3];")], {})
        self.assertEqual(found, [])

    def test_structured_candidates_outrank_loose_ones(self):
        structured = Found(url="https://cdn/x/mono.m3u8", origin="array", order=1)
        loose = Found(url="https://cdn/x/mono.m3u8", origin="dom", order=2)
        self.assertGreater(score_found(structured, True), score_found(loose, False))


class RegexTests(unittest.TestCase):
    def test_finds_bare_m3u8_and_unescapes(self):
        found = parse_regex_hls([("p", r'var u = "https:\/\/cdn.example\/live\/index.m3u8?x=1";')])
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].url, "https://cdn.example/live/index.m3u8?x=1")


class MatchingTests(unittest.TestCase):
    def setUp(self):
        self.found = [
            Found(url="https://cdn/1.m3u8", name="ALWAN SPORT 1", chan_id="1"),
            Found(url="https://cdn/2.m3u8", name="ALWAN SPORT 2", chan_id="2"),
        ]

    def test_match_by_string_id(self):
        self.assertEqual(_match_channel(self.found, {"source_channel": "1"}).url, "https://cdn/1.m3u8")

    def test_match_by_int_id_against_string_ids(self):
        self.assertEqual(_match_channel(self.found, {"source_channel": 2}).url, "https://cdn/2.m3u8")

    def test_match_by_name(self):
        self.assertEqual(_match_channel(self.found, {"source_name": "SPORT 2"}).url, "https://cdn/2.m3u8")

    def test_no_match_returns_none(self):
        self.assertIsNone(_match_channel(self.found, {"source_channel": "99"}))


class ChannelPageUrlTests(unittest.TestCase):
    def test_template_uses_source_channel(self):
        src = {"page": "https://alwanlive.stream/",
               "channel_page": "https://alwanlive.stream/?channel={channel}"}
        pick = Found(url="https://cdn/x.m3u8", name="ALWAN SPORT 3", chan_id="3")
        self.assertEqual(
            channel_page_url(src, {"source_channel": 3}, pick),
            "https://alwanlive.stream/?channel=3",
        )

    def test_each_channel_gets_its_own_page(self):
        src = {"channel_page": "https://alwanlive.stream/?channel={channel}"}
        for n in (1, 2, 9, 10):
            pick = Found(url="https://cdn/x.m3u8", chan_id=str(n))
            self.assertEqual(
                channel_page_url(src, {"source_channel": n}, pick),
                f"https://alwanlive.stream/?channel={n}",
            )

    def test_falls_back_to_platform_page_when_no_template(self):
        src = {"page": "https://example.tld/live"}
        pick = Found(url="https://cdn/x.m3u8", chan_id="1")
        self.assertEqual(channel_page_url(src, {"source_channel": 1}, pick), "https://example.tld/live")

    def test_supports_id_and_name_placeholders(self):
        src = {"channel_page": "https://x.tld/w/{id}/{name}"}
        pick = Found(url="https://cdn/x.m3u8", name="SPORT 4", chan_id="4")
        self.assertEqual(channel_page_url(src, {}, pick), "https://x.tld/w/4/SPORT 4")


class FallbackPageTests(unittest.TestCase):
    """رابط الصفحة الذي يُعرض كحل ثانوي عند فشل استخراج البث."""

    def test_explicit_fallback_url_wins(self):
        sport = {"source": "alwan", "source_channel": 7,
                 "fallback_url": "https://alwanlive.stream/?channel=7"}
        sources = {"alwan": {"page": "https://alwanlive.stream/",
                             "channel_page": "https://alwanlive.stream/?channel={channel}"}}
        self.assertEqual(fallback_page(sport, sources), "https://alwanlive.stream/?channel=7")

    def test_never_points_viewer_to_source_site_without_explicit_url(self):
        # سياسة الموقع: قنوات ألوان (Sport) لا تُوجَّه إلى موقع المصدر أبدًا
        sport = {"source": "alwan", "source_channel": 4}
        sources = {"alwan": {"page": "https://alwanlive.stream/",
                             "channel_page": "https://alwanlive.stream/?channel={channel}"}}
        self.assertEqual(fallback_page(sport, sources), "")

    def test_platform_page_is_not_used_either(self):
        sport = {"source": "x"}
        sources = {"x": {"page": "https://example.tld/live"}}
        self.assertEqual(fallback_page(sport, sources), "")

    def test_no_source_and_no_fallback_url_gives_empty(self):
        self.assertEqual(fallback_page({"source": None}, {}), "")

    def test_unconfigured_channel_with_explicit_url_still_gets_a_page(self):
        sport = {"source": None, "fallback_url": "https://alwanlive.stream/?channel=11"}
        self.assertEqual(fallback_page(sport, {}), "https://alwanlive.stream/?channel=11")



class NoSourcePageLeakTests(unittest.TestCase):
    """ملفات streams/*.json العامة لا تحمل رابط موقع المصدر (ألوان) أبدًا."""

    def _run(self, sport, pick):
        import json
        import tempfile
        from datetime import datetime, timezone
        from extract import _finish_found, fallback_page
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / f"{sport['id']}.json"
            _finish_found(sport, pick, p, fallback_page(sport, {}), datetime.now(timezone.utc), False)
            return json.loads(p.read_text(encoding="utf-8"))

    def test_ok_record_has_no_source_url_for_sport(self):
        from extract import Found
        out = self._run({"id": "sport1", "name": "Sport 1", "source": "alwan", "source_channel": 1},
                        Found(url="https://x.tld/live/a.m3u8", score=10))
        self.assertEqual(out["status"], "ok")
        self.assertIsNone(out["source_url"])

    def test_ok_record_keeps_explicit_fallback_url(self):
        from extract import Found
        out = self._run({"id": "alfajertv1", "name": "F", "fallback_url": "https://www.elahmad.ru/tv/watchtv.php?id=alfajertv"},
                        Found(url="https://x.tld/live/a.m3u8", score=10))
        self.assertEqual(out["source_url"], "https://www.elahmad.ru/tv/watchtv.php?id=alfajertv")

    def test_fallback_record_has_no_source_for_sport(self):
        import json
        import tempfile
        from datetime import datetime, timezone
        from extract import write_fallback
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "sport7.json"
            write_fallback({"id": "sport7", "name": "Sport 7", "source": "alwan"}, p, "", "غير متاح", datetime.now(timezone.utc), False)
            out = json.loads(p.read_text(encoding="utf-8"))
        self.assertEqual(out["status"], "fallback")
        self.assertIsNone(out["source_url"])
        self.assertNotIn("alwanlive", json.dumps(out))


class CryptAdapterTests(unittest.TestCase):
    """محوّل المصادر المشفّرة (AES-CBC) — قنوات الفجر. لا يحتاج شبكة."""

    def test_csrf_and_decrypt_via_handlers(self):
        """نحاكي HTTP بالكامل: صفحة فيها csrf، ثم POST يعيد حمولة مشفّرة."""
        import base64
        import json as _json
        from extract import extract_crypt
        from aes_cbc import decrypt_cbc  # noqa: F401  (للتوثيق)

        key = bytes(range(32))
        iv = bytes(range(16))
        url = "https://ruyas.store/fajer9/index.m3u8?token=abc"
        # نشفّر بـ AES مرجعي إن توفّر، وإلا نتخطّى (الاختبار يعتمد على تشفير حقيقي)
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            from cryptography.hazmat.primitives import padding as sympad
        except ImportError:
            self.skipTest("cryptography غير مثبّتة")
        padder = sympad.PKCS7(128).padder()
        padded = padder.update(url.encode()) + padder.finalize()
        enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
        ct = enc.update(padded) + enc.finalize()

        page_html = '<meta name="csrf-token" content="TOK123">'
        payload = _json.dumps({
            "link_4": base64.b64encode(ct).decode(),
            "key": key.hex(), "iv": iv.hex(),
        }).encode()

        class FakeResp:
            def __init__(self, data): self._d = data
            def read(self, *a): return self._d
            def __enter__(self): return self
            def __exit__(self, *a): return False

        calls = []

        class FakeOpener:
            def open(self, req, timeout=None):
                calls.append(req)
                if isinstance(req.data, (bytes, bytearray)):
                    return FakeResp(payload)
                return FakeResp(page_html.encode())

        import urllib.request as _u
        orig = _u.build_opener
        _u.build_opener = lambda *a, **k: FakeOpener()
        try:
            src = {"id": "elahmad", "kind": "crypt",
                   "page": "https://www.elahmad.ru/tv/watchtv.php",
                   "endpoint": "https://www.elahmad.ru/tv/result/embed_result_watchtv.php"}
            found = extract_crypt(src, {"name": "Alfajer TV 9", "source_id": "alfajertv9",
                                        "source_channel": "alfajertv9"})
        finally:
            _u.build_opener = orig

        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].url, url)
        self.assertEqual(found[0].origin, "crypt")
        # تأكيد أننا أرسلنا csrf في جسم POST
        post = [c for c in calls if isinstance(c.data, (bytes, bytearray))][0]
        self.assertIn(b"csrf_token=TOK123", post.data)

    def test_missing_csrf_raises(self):
        from extract import extract_crypt, ConfigError

        class FakeResp:
            def __init__(self, d): self._d = d
            def read(self, *a): return self._d
            def __enter__(self): return self
            def __exit__(self, *a): return False

        class FakeOpener:
            def open(self, req, timeout=None): return FakeResp(b"<html>no token</html>")

        import urllib.request as _u
        orig = _u.build_opener
        _u.build_opener = lambda *a, **k: FakeOpener()
        try:
            with self.assertRaises(ConfigError):
                extract_crypt({"id": "x", "kind": "crypt", "page": "https://x.tld/",
                               "endpoint": "https://x.tld/e"}, {"source_id": "y"})
        finally:
            _u.build_opener = orig


class SportsMapTests(unittest.TestCase):
    """خريطة sports.js التي تعرف بها الصفحة رابطها الاحتياطي بلا fetch."""

    def _map(self, sports, sources):
        import json, tempfile
        from pathlib import Path
        from extract import write_sports_map
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "sports.js"
            write_sports_map(sports, sources, p, dry=False)
            text = p.read_text(encoding="utf-8")
        # نستخرج الكائن المُسنَد إلى window.SPORTS ونقرأه كـ JSON
        blob = text[text.index("{", text.index("window.SPORTS")):text.rindex("}") + 1]
        return json.loads(blob)

    def test_each_channel_maps_to_its_own_page(self):
        sports = [{"id": "sport1", "source": "alwan", "source_channel": 1},
                  {"id": "sport2", "source": "alwan", "source_channel": 2}]
        sources = {"alwan": {"page": "https://alwanlive.stream/",
                             "channel_page": "https://alwanlive.stream/?channel={channel}"}}
        m = self._map(sports, sources)
        # لا نوجّه المشاهد إلى الموقع المصدر: القيم فارغة
        self.assertEqual(m["sport1"], "")
        self.assertEqual(m["sport2"], "")

    def test_sourceless_channel_is_empty_string_not_missing(self):
        m = self._map([{"id": "sport11", "source": None}], {})
        self.assertIn("sport11", m)
        self.assertEqual(m["sport11"], "")

    def test_explicit_fallback_url_is_used(self):
        sports = [{"id": "sport7", "source": None,
                   "fallback_url": "https://alwanlive.stream/?channel=7"}]
        self.assertEqual(self._map(sports, {})["sport7"], "https://alwanlive.stream/?channel=7")

    def test_dry_run_writes_nothing(self):
        import tempfile
        from pathlib import Path
        from extract import write_sports_map
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "sports.js"
            write_sports_map([{"id": "sport1", "source": None}], {}, p, dry=True)
            self.assertFalse(p.exists())


class Base64Tests(unittest.TestCase):
    def test_decodes_base64_hidden_url(self):
        import base64
        from extract import parse_base64
        url = "https://cdn.example/live/mono.m3u8?a=1"
        blob = base64.b64encode(url.encode()).decode()
        found = parse_base64([("p", f'var encUrl = "{blob}";')])
        self.assertTrue(any(f.url == url for f in found))



class ChannelServersTests(unittest.TestCase):
    JS = """
const channels = [ { id: 1, name: "A1", url: "https://lbgo.bozztv.com/x/1/chunks.m3u8", type: "hls" } ];
const channelServers = {
  1: ["https://w.workers.dev/playlist.m3u8?url=https://ok.ru/video/111", "https://s3/bein1/manifest.m3u8", "https://ok.ru/videoembed/9?nochat=1", "https://s3/bein1/manifest.m3u8"],
  2: ["https://w.workers.dev/playlist.m3u8?url=https://ok.ru/video/222"],
};
const x = 1;
"""

    def test_servers_parsed_in_order_and_deduped(self):
        found = parse_channel_servers([("https://alwanlive.stream/app.js", self.JS)])
        ch1 = [f for f in found if f.chan_id == "1"]
        self.assertEqual([f.order for f in ch1], [0, 1])          # embed تُتجاهل، والمكرر يُحذف
        self.assertIn("ok.ru/video/111", ch1[0].url)
        self.assertEqual(len([f for f in found if f.chan_id == "2"]), 1)

    def test_server_one_beats_legacy_channels_url(self):
        payloads = [("https://alwanlive.stream/app.js", self.JS)]
        found = parse_channel_servers(payloads) + parse_channel_arrays(payloads, {})
        cands = _candidates_for(found, {"source_channel": 1})
        self.assertIn("ok.ru/video/111", cands[0].url)
        self.assertTrue(cands[-1].url.startswith("https://lbgo.bozztv.com"))

    def test_channel_without_servers_uses_array_url(self):
        js = self.JS + 'const channels2 = [ { id: 7, name: "S7", url: "https://m.workers.dev/playlist.m3u8?url=https://ok.ru/video/7", type: "hls" } ];'
        found = parse_channel_servers([("a", js)]) + parse_channel_arrays([("a", js)], {})
        cands = _candidates_for(found, {"source_channel": 7})
        self.assertIn("ok.ru/video/7", cands[0].url)

if __name__ == "__main__":
    unittest.main(verbosity=2)
