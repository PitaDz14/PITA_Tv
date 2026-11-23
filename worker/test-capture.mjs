// اختبارات وضع الالتقاط (?mode=capture) — بلا شبكة: node --test worker/test-capture.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(here, ".hls-proxy.capture.mjs");
writeFileSync(tmp, readFileSync(join(here, "hls-proxy.js")));
const W = await import(tmp);
unlinkSync(tmp);

const ORIGIN = "https://pitadz14.github.io";
const realFetch = globalThis.fetch;
const calls = [];
function mock(routes) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = routes[String(url)];
    return r ? (typeof r === "function" ? r(init) : r.clone()) : new Response("nf", { status: 404 });
  };
}
test.afterEach(() => { globalThis.fetch = realFetch; calls.length = 0; });

const req = (qs, origin = ORIGIN) =>
  new Request("https://w.example/?" + qs, { headers: origin ? { Origin: origin } : {} });
const cap = (page, extra = "") => W.handle(req("mode=capture&u=" + encodeURIComponent(page) + extra));

test("يلتقط m3u8 مطلقًا من HTML الصفحة ويعيد JSON بلا كاش", async () => {
  mock({ "https://src.example/play.php?c=1": new Response('<script>var s="https://cdn.example/live/a/index.m3u8?t=abc";</script>', { status: 200 }) });
  const r = await cap("https://src.example/play.php?c=1");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.url, "https://cdn.example/live/a/index.m3u8?t=abc");
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(calls[0].init.headers["User-Agent"], "VLC/3.0.18 LibVLC/3.0.18");
});

test("يحلّ مسار m3u8 نسبيًا ويفكّ \\/ المهرّبة", async () => {
  mock({ "https://src.example/p/page.html": new Response('{"file":"\\/live\\/x\\/index.m3u8?k=1"}', { status: 200 }) });
  const j = await (await cap("https://src.example/p/page.html")).json();
  assert.equal(j.ok, true);
  assert.equal(j.url, "https://src.example/live/x/index.m3u8?k=1");
});

test("لا رابط بث في الصفحة ⇒ 404 مع ok:false", async () => {
  mock({ "https://src.example/e": new Response("<html>nothing</html>", { status: 200 }) });
  const r = await cap("https://src.example/e");
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "no-stream-found");
});

test("raw=1 يعيد HTML كما هو", async () => {
  mock({ "https://src.example/r": new Response("<b>hi</b>", { status: 200 }) });
  const r = await cap("https://src.example/r", "&raw=1");
  assert.equal(await r.text(), "<b>hi</b>");
  assert.match(r.headers.get("Content-Type"), /text\/html/);
});

test("يرفض أصلًا غير مسموح قبل أي جلب", async () => {
  mock({});
  const r = await W.handle(req("mode=capture&u=" + encodeURIComponent("https://src.example/x"), "https://evil.example"));
  assert.equal(r.status, 403);
  const r2 = await W.handle(req("mode=capture&u=" + encodeURIComponent("https://src.example/x"), null));
  assert.equal(r2.status, 403);
  assert.equal(calls.length, 0);
});

test("يرفض الأهداف المحلية وغير http(s) ورابطًا معطوبًا", async () => {
  mock({});
  for (const bad of ["http://localhost/x", "http://127.0.0.1/x", "http://192.168.1.5/x", "http://10.0.0.1/x", "ftp://a.example/x", "http://[::1]/x"])
    assert.equal((await cap(bad)).status, 403, bad);
  assert.equal((await cap("not a url")).status, 400);
  assert.equal(calls.length, 0);
});

test("فشل الجلب ⇒ 502 بدل انهيار الـ Worker", async () => {
  mock({ "https://src.example/boom": () => { throw new Error("net"); } });
  const r = await cap("https://src.example/boom");
  assert.equal(r.status, 502);
});

test("بدون mode=capture لا يتغيّر السلوك الأصلي (OPTIONS و405)", async () => {
  const o = await W.handle(new Request("https://w.example/?u=x", { method: "OPTIONS", headers: { Origin: ORIGIN } }));
  assert.equal(o.status, 204);
  const p = await W.handle(new Request("https://w.example/?u=x", { method: "POST", headers: { Origin: ORIGIN } }));
  assert.equal(p.status, 405);
});

test("ref اختياري يُرسل كترويسة Referer، وغيابه لا يرسلها", async () => {
  mock({ "https://src.example/ref": new Response('x="https://c.example/a.m3u8"', { status: 200 }) });
  await cap("https://src.example/ref");
  assert.equal(calls[0].init.headers["Referer"], undefined);
  await cap("https://src.example/ref", "&ref=" + encodeURIComponent("https://pitadz14.github.io/"));
  assert.equal(calls[1].init.headers["Referer"], "https://pitadz14.github.io/");
  await cap("https://src.example/ref", "&ref=javascript:alert(1)");
  assert.equal(calls[2].init.headers["Referer"], undefined);
});
