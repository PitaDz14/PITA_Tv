// اختبارات مستخرج elahmad العام (?r=e:…) — بلا شبكة: node --test worker/test-elahmad.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// الملف الأصلي ESM لكنه يُحمَّل كـ .js؛ ننسخه مؤقتًا بامتداد .mjs
const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(here, ".hls-proxy.test.mjs");
writeFileSync(tmp, readFileSync(join(here, "hls-proxy.js")));
const W = await import(tmp);
import { unlinkSync } from "node:fs";
unlinkSync(tmp);

const KEY = crypto.randomBytes(32), IV = crypto.randomBytes(16);
const enc = (plain) => { const c = crypto.createCipheriv("aes-256-cbc", KEY, IV); return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64"); };
const STREAM = "https://cdn.example.net/live/chan/index.m3u8?token=abc";
const P = (u) => W.elahmadPageFromRid("e:" + u);

// يبني fetch وهميًا: routes = { "GET https://…": () => Response }
function mockFetch(routes, log = []) {
  return async (url, init = {}) => {
    const k = (init.method || "GET") + " " + url;
    log.push({ k, init });
    const r = routes[k];
    if (!r) return new Response("nf", { status: 404 });
    return typeof r === "function" ? r(init) : r;
  };
}
const html = (s) => new Response(s, { status: 200, headers: { "Content-Type": "text/html" } });

test("rid: يقبل مسار /tv/ ورابطًا كاملًا ويرفض غير elahmad", () => {
  assert.equal(P("mobiletv/glarb.php?id=cbc_tv").href, "https://www.elahmad.ru/tv/mobiletv/glarb.php?id=cbc_tv");
  assert.equal(P("https://www.elahmad.ru/tv/radiant.php?id=2m").pathname, "/tv/radiant.php");
  assert.equal(P("https://elahmad.ru/tv/radiant.php?id=2m").hostname, "www.elahmad.ru");
  for (const bad of ["https://evil.com/tv/x.php", "https://www.elahmad.ru.evil.com/tv/x.php", "http://www.elahmad.ru/tv/x.php",
    "https://www.elahmad.ru/other/x.php", "https://www.elahmad.ru/tv/../admin", "https://user:p@www.elahmad.ru/tv/x", "https://www.elahmad.ru:8443/tv/x",
    "https://www.elahmad.ru/tv//x", ""]) assert.equal(W.elahmadPageFromRid("e:" + bad), null, bad);
  assert.equal(W.elahmadPageFromRid("alfajertv1"), null);
});

test("المرحلة 1: حمولة مشفّرة داخل الصفحة", async () => {
  const page = `<script>var encryptedUrls = "${enc(JSON.stringify(["https://x/y.mp4", STREAM]))}"; var keyHex = "${KEY.toString("hex")}"; const ivHex = '${IV.toString("hex")}';</script>`;
  const r = await W.resolveElahmad(P("mobiletv/glarb.php?id=a"), mockFetch({ "GET https://www.elahmad.ru/tv/mobiletv/glarb.php?id=a": html(page) }));
  assert.equal(r.url, STREAM); assert.equal(r.via, "inline-crypt");
});

test("المرحلة 2: csrf + POST (نقطة مشتقة من اسم الصفحة) + فكّ link_4", async () => {
  const log = [];
  const f = mockFetch({
    "GET https://www.elahmad.ru/tv/watchtv.php?id=saudi_sport": () => new Response('<meta name="csrf-token" content="TOK123">', { headers: { "Set-Cookie": "PHPSESSID=s1; path=/" } }),
    "POST https://www.elahmad.ru/tv/result/embed_result_watchtv.php": (init) => {
      assert.match(String(init.body), /id=saudi_sport/); assert.match(String(init.body), /csrf_token=TOK123/);
      assert.match(init.headers.Cookie || "", /PHPSESSID=s1/);
      return new Response(JSON.stringify({ link_4: enc(STREAM), key: KEY.toString("hex"), iv: IV.toString("hex") }));
    },
  }, log);
  const r = await W.resolveElahmad(P("watchtv.php?id=saudi_sport"), f);
  assert.equal(r.url, STREAM); assert.equal(r.via, "post");
});

test("المرحلة 2: نقطة POST تُكتشف من سكربت الصفحة", async () => {
  const f = mockFetch({
    "GET https://www.elahmad.ru/tv/radiant.php?id=2m": html('<meta name="csrf-token" content="T"><script src="/tv/js/player.js"></script>'),
    "GET https://www.elahmad.ru/tv/js/player.js": html('$.post("result/embed_result_custom.php",{id:ID})'),
    "POST https://www.elahmad.ru/tv/result/embed_result_custom.php": new Response(JSON.stringify({ link_2: enc(STREAM), key: KEY.toString("hex"), iv: IV.toString("hex") })),
  });
  const r = await W.resolveElahmad(P("radiant.php?id=2m"), f);
  assert.equal(r.url, STREAM);
});

test("المرحلة 3: m3u8 صريح (نص عادي و base64) مع تجاهل روابط الإعلانات/المكتبات", async () => {
  const urls = W.findM3u8Urls(`x https:\\/\\/www.google.com/a.m3u8 y "${STREAM}" z`);
  assert.deepEqual(urls, [STREAM]);
  const b64 = Buffer.from(STREAM).toString("base64");
  assert.deepEqual(W.findM3u8Urls(`atob("${b64}")`), [STREAM]);
  const r = await W.resolveElahmad(P("algeria_live.php?id=x"), mockFetch({ "GET https://www.elahmad.ru/tv/algeria_live.php?id=x": html(`<script>player.src({src:"${STREAM}"})</script>`) }));
  assert.equal(r.via, "direct");
});

test("المرحلة 4: iframe من نفس الموقع ثم استخراج منه", async () => {
  const r = await W.resolveElahmad(P("arabic-tv-online.php?id=cima"), mockFetch({
    "GET https://www.elahmad.ru/tv/arabic-tv-online.php?id=cima": html('<iframe src="/tv/embed/cima.php"></iframe><iframe src="https://ads.example/x"></iframe>'),
    "GET https://www.elahmad.ru/tv/embed/cima.php": html(`<script>var u="${STREAM}"</script>`),
  }));
  assert.equal(r.url, STREAM); assert.equal(r.via, "direct");
});

test("فشل: صفحة يوتيوب بلا بث ⇒ ResolveError مع trace وملخص الصفحة", async () => {
  await assert.rejects(
    W.resolveElahmad(P("youtube.php?id=x"), mockFetch({ "GET https://www.elahmad.ru/tv/youtube.php?id=x": html('<iframe src="https://www.youtube.com/embed/abc"></iframe>') })),
    (e) => e.stage === "none" && Array.isArray(e.extra.trace) && e.extra.trace.length >= 3 && e.extra.page && e.extra.page.iframes.length === 1);
  await assert.rejects(W.resolveElahmad(P("a.php"), mockFetch({})), (e) => e.stage === "page" && /404/.test(e.message));
});

test("سقف الطلبات: لا يتجاوز الاستخراج الواحد 18 طلبًا", async () => {
  const log = [];
  const scripts = Array.from({ length: 10 }, (_, i) => `<script src="/tv/js/s${i}.js"></script>`).join("");
  const f = mockFetch({ "GET https://www.elahmad.ru/tv/a.php?id=1": html(scripts + '<meta name="csrf-token" content="T">') }, log);
  await assert.rejects(W.resolveElahmad(P("a.php?id=1"), f));
  assert.ok(log.length <= 18, "طلبات: " + log.length);
});

test("makeResolver: كاش النجاح، كاش الفشل لدقيقة، ورفض المعرّفات الخطأ", async () => {
  let t = 1000; const log = [];
  const f = mockFetch({ "GET https://www.elahmad.ru/tv/a.php?id=ok": html(`"${STREAM}"`) }, log);
  const resolve = W.makeResolver(f, () => t);
  const a = await resolve("e:a.php?id=ok"); const b = await resolve("e:a.php?id=ok");
  assert.equal(a.url, b.url); assert.equal(log.length, 1);
  await assert.rejects(resolve("e:a.php?id=bad"), (e) => e.stage === "page");
  const n = log.length;
  await assert.rejects(resolve("e:a.php?id=bad"));      // من كاش الفشل
  assert.equal(log.length, n);
  t += 61_000;
  await assert.rejects(resolve("e:a.php?id=bad"));
  assert.ok(log.length > n);
  await assert.rejects(resolve("e:https://evil.com/tv/x"), (e) => e.stage === "id");
  await assert.rejects(resolve("nochannel"), (e) => e.stage === "id");
});

test("handle: ?r=e:… يعيد قائمة HLS معاد كتابتها، و debug يعرض trace، والمقاطع لا تُعيد الاستخراج", async () => {
  const realFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://www.elahmad.ru/tv/mobiletv/glarb.php")) return html(`<script>x="${STREAM}"</script>`);
    if (String(url).startsWith("https://cdn.example.net/live/chan/index.m3u8"))
      return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n", { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    if (String(url).startsWith("https://cdn.example.net/live/chan/seg1.ts")) return new Response("TSDATA", { headers: { "Content-Type": "video/mp2t" } });
    return new Response("nf", { status: 404 });
  };
  try {
    const resolve = W.makeResolver();
    const origin = "https://pitadz14.github.io";
    const mk = (qs) => new Request("https://w.example/?" + qs, { headers: { Origin: origin } });
    const rid = "e:mobiletv/glarb.php?id=cbc_tv";
    const r = await W.handle(mk("r=" + encodeURIComponent(rid)), ["*"], [origin], W.defaultIpHost, {}, resolve, null);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /^#EXTM3U/);
    assert.match(body, /r=e%3Amobiletv%2Fglarb\.php%3Fid%3Dcbc_tv&u=https%3A%2F%2Fcdn\.example\.net%2Flive%2Fchan%2Fseg1\.ts%3Ftoken%3Dabc/);
    assert.equal(calls.find((c) => c.url.startsWith("https://cdn.example.net/live/chan/index.m3u8")).init.headers["Referer"], "https://www.elahmad.ru/");
    // طلب مقطع (r + u): بلا استخراج جديد
    const before = calls.filter((c) => c.url.includes("elahmad.ru")).length;
    const seg = await W.handle(mk("r=" + encodeURIComponent(rid) + "&u=" + encodeURIComponent("https://cdn.example.net/live/chan/seg1.ts?token=abc")), ["*"], [origin], W.defaultIpHost, {}, resolve, null);
    assert.equal(seg.status, 200); assert.equal(await seg.text(), "TSDATA");
    assert.equal(calls.filter((c) => c.url.includes("elahmad.ru")).length, before);
    // debug
    const d = await W.handle(mk("r=" + encodeURIComponent(rid) + "&debug=1"), ["*"], [origin], W.defaultIpHost, {}, resolve, null);
    const dj = await d.json(); assert.equal(dj.ok, true); assert.equal(dj.via, "direct"); assert.ok(dj.trace.length);
    assert.equal(dj.probe.status, 200); assert.equal(dj.probe.is_hls, true);
    assert.ok(!JSON.stringify(dj).includes("token=abc"), "الـ token يجب أن يبقى مخفيًا");
    // معرّف غير صالح
    const bad = await W.handle(mk("r=" + encodeURIComponent("e:https://evil.com/tv/x")), ["*"], [origin], W.defaultIpHost, {}, resolve, null);
    assert.equal(bad.status, 404);
    // فشل الاستخراج ⇒ 502 (الواجهة تعرض الصفحة الأصلية)
    const fail = await W.handle(mk("r=" + encodeURIComponent("e:nothing.php?id=1")), ["*"], [origin], W.defaultIpHost, {}, resolve, null);
    assert.equal(fail.status, 502);
  } finally { globalThis.fetch = realFetch; }
});

test("لا تغيير في قنوات الفجر/الكأس القديمة (?r=alkass1)", async () => {
  const page = `<script>var encryptedUrls = "${enc(JSON.stringify(["https://x.alkassdigital.net/a/b.m3u8?hdnts=1"]))}"; var keyHex = "${KEY.toString("hex")}"; var ivHex = "${IV.toString("hex")}";</script>`;
  const resolve = W.makeResolver(mockFetch({ "GET https://www.elahmad.ru/tv/live/alkass-net.php?id=one": html(page) }));
  const r = await resolve("alkass1");
  assert.match(r.url, /alkassdigital\.net/);
});

// ── صفحة radiant.php الحقيقية: عنوان نقطة الاستخراج مخفي بـ XOR(k) + base64 ──
const xorPage = (endpoint, k = 19) => {
  const b64 = Buffer.from(`var embed_result = "${endpoint}";`).toString("base64");
  const arr = [...b64].map((c) => c.charCodeAt(0) ^ k);
  return `(function(){for(var d=[${arr.join(",")}],k=${k},_283='',i=0;i<d.length;i++)_283+=String.fromCharCode(d[i]^k);eval(atob(_283))})();`;
};

test("deobfuscateXorArrays: يفكّ XOR ثم base64 (بمفتاح ظاهر أو بالتجريب)", () => {
  const sc = xorPage("/tv/result/embed_result_elahmad_85.php");
  const out = W.deobfuscateXorArrays(sc);
  assert.ok(out.some((x) => x.includes('embed_result = "/tv/result/embed_result_elahmad_85.php"')), JSON.stringify(out));
  const noKey = sc.replace(/,k=19/, ",kk=0");   // لا k ظاهر ⇒ تجريب كل المفاتيح
  assert.ok(W.deobfuscateXorArrays(noKey).some((x) => x.includes("embed_result_elahmad_85")));
  assert.deepEqual(W.deobfuscateXorArrays("var a=[1,2,3];"), []);
});

test("radiant.php: نقطة POST مخفية بـ XOR تُكتشف ويُستخرج منها البث", async () => {
  const log = [];
  const f = mockFetch({
    "GET https://www.elahmad.ru/tv/radiant.php?id=aloula1": html(`<meta name="csrf-token" content="CT9"><script src="/tv/js/new_player.min.js?v=1"></script><script>${xorPage("/tv/result/embed_result_elahmad_85.php")}</script>`),
    "GET https://www.elahmad.ru/tv/js/new_player.min.js?v=1": html('var a="/tv/result/algerie_result.php",b="/tv/result/itworks_result.php";'),
    "POST https://www.elahmad.ru/tv/result/embed_result_elahmad_85.php": new Response(JSON.stringify({ link_4: enc(STREAM), key: KEY.toString("hex"), iv: IV.toString("hex") })),
    "POST https://www.elahmad.ru/tv/result/algerie_result.php": new Response("[0,1]"),
  }, log);
  const r = await W.resolveElahmad(P("radiant.php?id=aloula1"), f);
  assert.equal(r.url, STREAM); assert.equal(r.via, "post");
  const posts = log.filter((x) => x.k.startsWith("POST")).map((x) => x.k);
  assert.equal(posts[0], "POST https://www.elahmad.ru/tv/result/embed_result_elahmad_85.php", "نقطة embed_result أولًا");
});

test("فشل POST يسجّل رأس الردّ، والفشل النهائي يعرض hints للتشخيص", async () => {
  const f = mockFetch({
    "GET https://www.elahmad.ru/tv/radiant.php?id=z": html(`<meta name="csrf-token" content="C"><script>${xorPage("/tv/result/embed_result_elahmad_85.php")}</script>`),
    "POST https://www.elahmad.ru/tv/result/embed_result_elahmad_85.php": new Response('["x",1]'),
  });
  await assert.rejects(W.resolveElahmad(P("radiant.php?id=z"), f), (e) => {
    const post = e.extra.trace.find((x) => x.step === "post");
    return e.stage === "none" && /\["x",1\]/.test(post.note) && e.extra.hints.endpoints[0] === "/tv/result/embed_result_elahmad_85.php"
      && e.extra.hints.decoded.length >= 1;
  });
});
