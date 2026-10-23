// PITA TV - HTTPS proxy for HTTP HLS streams (Cloudflare Workers)
// الاستخدام:
//   ?u=<رابط HTTP مُرمَّز بـ encodeURIComponent>   روابط عامة (تظهر في شيفرة الموقع)
//   ?url=<رابط HTTP مُرمَّز>                        اسم بديل لـ ?u=
//   ?u=<رابط>&debug=stream                         تشخيص الاستجابة/HLS بدون كشف بيانات حساسة
//   ?u=<رابط>&debug=codec                          فحص أول مقطع HLS وتحديد Codec الفيديو/الصوت (MPEG-TS)
//   ?c=<معرّف قصير>                                 قنوات الاشتراك: الرابط الحقيقي محفوظ هنا كسرّ (Secret) باسم CHANNELS
//   ?r=<معرّف قناة>                                 قنوات تُستخرج روابطها عند الطلب (الفجر): alfajertv1 … alfajertv5
//   ?r=<معرّف>&debug=1                              تشخيص مراحل الاستخراج (JSON، الـ token مخفي)
//   ?d=duhok                                        معرّف فيديو ok.ru الحالي لقناة Duhok (JSON) — يُضمَّن في iframe
//   ?d=duhok&debug=1                                نفسه مع ما فُحص وما وُجد (لتشخيص الاكتشاف)
//
// شكل السرّ CHANNELS (JSON):  {"w9":"http://server/live/user/pass/1.ts","sport1":"http://..."}

// السيرفرات المسموح بها. "*" = أي سيرفر (الأبسط: لا تحتاج تعديل الوسيط عند إضافة قنوات).
// لتقييدها اكتب مثلاً: ["4kgood.org", "5.180.164.197:8080"]  (المنفذ 80 لا يُكتب)
const ALLOWED_TARGETS = ["*"];
// الـ User-Agent الذي يُرسَل إلى سيرفر البث
const UPSTREAM_UA = "VLC/3.0.18 LibVLC/3.0.18";
// المواقع المسموح لها باستعمال هذا الوسيط
const ALLOWED_ORIGINS = ["https://pitadz14.github.io"];

// ───────────────────────── محوّل الاستخراج عند الطلب (?r=) ─────────────────────────
// نفس ما يفعله scripts/extract.py (kind=crypt) لكن داخل الـ Worker:
//   GET صفحة القناة (csrf + كعكة) ← POST إلى endpoint ← فكّ AES-CBC ← رابط m3u8 بـ token طازج.
// الرابط يُستخدم من نفس الـ Worker الذي استخرجه، فلا يضرّ لو كان الـ token مرتبطًا بعنوان IP.
const SOURCE_ELAHMAD = {
  page: "https://www.elahmad.ru/tv/watchtv.php?id={id}",
  endpoint: "https://www.elahmad.ru/tv/result/embed_result_watchtv.php",
  cipherField: "link_4", keyField: "key", ivField: "iv", idField: "id", csrfField: "csrf_token",
};
// معرّف القناة عندنا ← معرّف المنصة (alfajertv1 عند المنصة اسمه alfajertv)
const RESOLVERS = {
  alfajertv1: { source: SOURCE_ELAHMAD, sid: "alfajertv" },
  alfajertv2: { source: SOURCE_ELAHMAD, sid: "alfajertv2" },
  alfajertv3: { source: SOURCE_ELAHMAD, sid: "alfajertv3" },
  alfajertv4: { source: SOURCE_ELAHMAD, sid: "alfajertv4" },
  alfajertv5: { source: SOURCE_ELAHMAD, sid: "alfajertv5" },
};
// نفس User-Agent الذي نجح مع هذه المنصة في extract.py
const RESOLVER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const RESOLVE_TTL_MS = 5 * 60 * 1000;        // نعيد استعمال الرابط المستخرج 5 دقائق
const RESOLVE_MIN_GAP_MS = 15 * 1000;        // لا نُعيد الاستخراج الإجباري أكثر من مرة كل 15 ثانية (حماية المصدر)

const CSRF_PATTERNS = [
  /name=["']csrf-token["']\s+content=["']([^"']+)/i,
  /content=["']([^"']+)["']\s+name=["']csrf-token["']/i,
  /name=["']csrf_token["']\s+value=["']([^"']+)/i,
];

class ResolveError extends Error {
  constructor(stage, msg) { super(stage + ": " + msg); this.stage = stage; }
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("hex غير صالح");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// AES-CBC + حشو PKCS#7 (WebCrypto يزيل الحشو بنفسه). يدعم مفاتيح 128/192/256 بت.
export async function decryptAesCbc(cipherB64, keyHex, ivHex) {
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: hexToBytes(ivHex) }, key, b64ToBytes(cipherB64));
  return new TextDecoder().decode(plain).trim();
}

function cookieHeaderFrom(res) {
  let list = [];
  if (typeof res.headers.getSetCookie === "function") list = res.headers.getSetCookie();
  else { const raw = res.headers.get("set-cookie"); if (raw) list = raw.split(/,(?=\s*[^;,\s]+=)/); }
  return list.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

export function isStreamish(u) {
  if (typeof u !== "string" || !/^https?:\/\//i.test(u)) return false;
  if (/\.m3u8|mpegurl/i.test(u)) return true;
  try { for (const v of new URL(u).searchParams.values()) if (/\.m3u8|mpegurl/i.test(v)) return true; } catch (e) { /* ignore */ }
  return false;
}

// يُنشئ دالة resolve(id, force) مع كاش داخل الذاكرة ودمج الطلبات المتزامنة.
export function makeResolver(fetchFn = (...a) => fetch(...a), now = () => Date.now()) {
  const cache = new Map();
  const inflight = new Map();

  async function run(rid) {
    const spec = RESOLVERS[rid];
    const src = spec.source;
    const page = src.page.replace("{id}", encodeURIComponent(spec.sid));
    const baseHeaders = { "User-Agent": RESOLVER_UA, "Accept-Language": "ar,en;q=0.9" };

    let r1;
    try { r1 = await fetchFn(page, { headers: baseHeaders, redirect: "follow" }); }
    catch (e) { throw new ResolveError("page", "تعذّر الاتصال (" + e.message + ")"); }
    if (!r1.ok) throw new ResolveError("page", "HTTP " + r1.status);
    const html = await r1.text();
    const cookie = cookieHeaderFrom(r1);

    let csrf = "";
    for (const re of CSRF_PATTERNS) { const m = html.match(re); if (m) { csrf = m[1]; break; } }
    if (!csrf) throw new ResolveError("csrf", "لم يُعثر على csrf-token في الصفحة");

    const form = new URLSearchParams({ [src.idField]: spec.sid, [src.csrfField]: csrf }).toString();
    const headers2 = { ...baseHeaders, "Content-Type": "application/x-www-form-urlencoded", Referer: page, "X-Requested-With": "XMLHttpRequest" };
    if (cookie) headers2.Cookie = cookie;
    let r2;
    try { r2 = await fetchFn(src.endpoint, { method: "POST", headers: headers2, body: form }); }
    catch (e) { throw new ResolveError("post", "تعذّر الاتصال (" + e.message + ")"); }
    if (!r2.ok) throw new ResolveError("post", "HTTP " + r2.status);

    let data;
    try { data = JSON.parse(await r2.text()); } catch (e) { throw new ResolveError("json", "الاستجابة ليست JSON"); }
    if (data && data.error) throw new ResolveError("json", "المصدر أرجع خطأ");
    for (const f of [src.cipherField, src.keyField, src.ivField])
      if (!data || !data[f]) throw new ResolveError("fields", "الحقل " + f + " مفقود");

    let url;
    try { url = await decryptAesCbc(data[src.cipherField], data[src.keyField], data[src.ivField]); }
    catch (e) { throw new ResolveError("decrypt", "فشل فكّ التشفير"); }
    if (!isStreamish(url)) throw new ResolveError("shape", "الرابط المفكوك ليس m3u8");

    return { url, at: now(), host: new URL(url).host };
  }

  return async function resolve(rid, force = false) {
    if (!Object.prototype.hasOwnProperty.call(RESOLVERS, rid)) throw new ResolveError("id", "قناة غير معروفة");
    const hit = cache.get(rid);
    if (hit) {
      const age = now() - hit.at;
      if (!force && age < RESOLVE_TTL_MS) return hit;
      if (force && age < RESOLVE_MIN_GAP_MS) return hit;
    }
    if (inflight.has(rid)) return inflight.get(rid);
    const p = run(rid).then((r) => { cache.set(rid, r); return r; }).finally(() => inflight.delete(rid));
    inflight.set(rid, p);
    return p;
  };
}

// يحدّث token رابط قديم بقيم الرابط المستخرج حديثًا (إن كان من نفس السيرفر)
export function refreshToken(oldHref, freshHref) {
  const o = new URL(oldHref), f = new URL(freshHref);
  if (o.host !== f.host) return oldHref;
  for (const [k, v] of f.searchParams) if (o.searchParams.has(k) || !o.search) o.searchParams.set(k, v);
  return o.href;
}

// إخفاء الـ token في رسائل التشخيص
function maskUrl(href) {
  try { const u = new URL(href); return u.origin + u.pathname + (u.search ? "?…" : ""); } catch (e) { return "?"; }
}

// ───────────────────────── اكتشاف معرّف فيديو ok.ru (?d=) ─────────────────────────
// بعض القنوات (Duhok Sport) تبثّ عبر فيديو على ok.ru يتغيّر رقمه كل فترة، والصفحة تحمّله بالجافاسكربت.
// المكتشف يفحص الصفحة + سكربتاتها + نقاط API التي تظهر فيها، ويبحث عن الرقم بعدّة أنماط
// (ok.ru/videoembed/… ، ok.ru/video/… ، …/mid/… داخل روابط okcdn) ثم يعيده لتضمينه في iframe على موقعك.
// المتصفح يفتح ok.ru بنفسه، فلا مشكلة ربط الرابط بالـ IP.
const DISCOVERERS = {
  duhok: { page: "https://duhoksport.net/", fallbackId: "15891924131507" },
};
const DISCOVER_TTL_MS = 2 * 60 * 1000;
const DISCOVER_MIN_GAP_MS = 10 * 1000;
const OK_PATTERNS = [
  ["embed", /ok\.ru\/videoembed\/(\d{9,})/g],
  ["video", /ok\.ru\/video\/(\d{9,})/g],
  ["live", /ok\.ru\/live\/(\d{9,})/g],
  ["mid", /\/mid\/(\d{9,})(?![\d])/g],
  ["field", /["']?(?:mid|movieId|videoId|okId|okid)["']?\s*[:=]\s*["']?(\d{12,})/g],
];
const SKIP_SCRIPT_HOSTS = /(googleapis|gstatic|cdnjs|jsdelivr|unpkg|jquery|bootstrapcdn|fontawesome|google-analytics|googletagmanager|facebook|fbcdn|tiktok|cloudflareinsights|doubleclick)/i;
const STATIC_EXT = /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|ts|map)(?:\?|$)/i;

function normalizeText(t) {
  return String(t).replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/").replace(/%2[fF]/g, "/").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// يرجع { kind: [ids…] } من نص واحد (مع محاولة فكّ blobs الـ base64 مرة واحدة)
export function findOkIds(text) {
  const out = {};
  const scan = (raw) => {
    const t = normalizeText(raw);
    for (const [kind, re] of OK_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) (out[kind] = out[kind] || []).push(m[1]);
    }
  };
  scan(text);
  const blobs = String(text).match(/[A-Za-z0-9+/_-]{40,}={0,2}/g) || [];
  for (const b of blobs.slice(0, 60)) {
    try { scan(atob(b.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b.length / 4) * 4, "="))); } catch (e) { /* ليس base64 */ }
  }
  return out;
}

export function rankOkIds(perPayload) {
  // perPayload: [{ kind: [ids] }] → [{id, kind, count}] مرتبة: نوع الرابط أولًا ثم التكرار ثم أول ظهور
  const stat = new Map();
  let order = 0;
  for (const p of perPayload) {
    for (const kind of Object.keys(p)) {
      for (const id of p[kind]) {
        const s = stat.get(id) || { id, kind, count: 0, order: order++ };
        s.count++;
        if (OK_PATTERNS.findIndex((x) => x[0] === kind) < OK_PATTERNS.findIndex((x) => x[0] === s.kind)) s.kind = kind;
        stat.set(id, s);
      }
    }
  }
  const rank = (k) => OK_PATTERNS.findIndex((x) => x[0] === k);
  return [...stat.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || b.count - a.count || a.order - b.order);
}

// ملخص قصير لما استلمه الـ Worker من الصفحة (للتشخيص فقط، مع debug=1)
export function summarizePage(html) {
  const title = ((html.match(/<title[^>]*>([^<]*)/i) || [])[1] || "").trim().slice(0, 80);
  const inline = [];
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi))
    inline.push({ bytes: m[1].length, head: m[1].trim().slice(0, 400) });
  const external = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)/gi)].map((m) => m[1]).slice(0, 10);
  const iframes = [...html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)/gi)].map((m) => m[1]).slice(0, 5);
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return { bytes: html.length, title, external, iframes, inline_count: inline.length, inline: inline.slice(0, 4), text_head: text };
}

export function makeDiscoverer(fetchFn = (...a) => fetch(...a), now = () => Date.now()) {
  const cache = new Map();
  const inflight = new Map();
  const headers = { "User-Agent": RESOLVER_UA, "Accept-Language": "ar,en;q=0.9", Accept: "*/*" };
  const path = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch (e) { return String(u).slice(0, 60); } };

  async function get(url, trace) {
    try {
      const r = await fetchFn(url, { headers, redirect: "follow" });
      const text = r.ok ? (await r.text()).slice(0, 2_000_000) : "";
      trace.push({ url: path(url), status: r.status });
      return text;
    } catch (e) {
      trace.push({ url: path(url), status: 0, error: String(e.message || e).slice(0, 60) });
      return "";
    }
  }

  async function run(spec) {
    const trace = [];
    const html = await get(spec.page, trace);
    const payloads = [{ url: spec.page, text: html }];
    const pageHost = new URL(spec.page).host;

    // السكربتات الخارجية: نفس الموقع أولًا، ثم القليل من غيره (بلا مكتبات معروفة)
    const srcs = [];
    for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      try { srcs.push(new URL(m[1], spec.page).href); } catch (e) { /* تجاهل */ }
    }
    const same = srcs.filter((u) => new URL(u).host === pageHost);
    const other = srcs.filter((u) => new URL(u).host !== pageHost && !SKIP_SCRIPT_HOSTS.test(new URL(u).host));
    for (const u of [...same.slice(0, 10), ...other.slice(0, 3)]) payloads.push({ url: u, text: await get(u, trace) });

    // نقاط API/JSON المذكورة داخل النصوص (نفس الموقع فقط)
    const endpoints = new Set();
    for (const p of payloads) {
      const t = normalizeText(p.text);
      for (const m of t.matchAll(/["'`]((?:https?:\/\/[^"'`\s<>]+)|(?:\/[A-Za-z0-9_\-./]+(?:\?[^"'`\s<>]*)?))["'`]/g)) {
        const cand = m[1];
        if (STATIC_EXT.test(cand) || !/(api|json|stream|player|embed|live|channel|source|config|data|match)/i.test(cand)) continue;
        try {
          const abs = new URL(cand, p.url);
          if (abs.host === pageHost && abs.href !== spec.page) endpoints.add(abs.href);
        } catch (e) { /* تجاهل */ }
      }
    }
    for (const u of [...endpoints].slice(0, 6)) payloads.push({ url: u, text: await get(u, trace) });

    const ranked = rankOkIds(payloads.map((p) => findOkIds(p.text)));
    return { ranked, trace, page: summarizePage(html), at: now() };
  }

  return async function discover(did, opts = {}) {
    if (!Object.prototype.hasOwnProperty.call(DISCOVERERS, did)) throw new ResolveError("id", "قناة غير معروفة");
    const spec = DISCOVERERS[did];
    const hit = cache.get(did);
    if (hit) {
      const age = now() - hit.at;
      if (!opts.force && age < DISCOVER_TTL_MS) return hit;
      if (opts.force && age < DISCOVER_MIN_GAP_MS) return hit;
    }
    if (!inflight.has(did)) {
      const p = run(spec).then((res) => {
        const top = res.ranked[0];
        const out = top
          ? { id: top.id, source: "page", kind: top.kind, candidates: res.ranked.slice(0, 5), trace: res.trace, page: res.page, at: res.at }
          : opts.envId && /^\d{9,}$/.test(opts.envId)
            ? { id: opts.envId, source: "env", kind: "env", candidates: [], trace: res.trace, page: res.page, at: res.at }
            : { id: spec.fallbackId, source: "fallback", kind: "fallback", candidates: [], trace: res.trace, page: res.page, at: res.at };
        cache.set(did, out);
        return out;
      }).finally(() => inflight.delete(did));
      inflight.set(did, p);
    }
    return inflight.get(did);
  };
}

// ───────────────────────── الوسيط ─────────────────────────

// Cloudflare Workers ترفض جلب عنوان IP خام (خطأ 1003). الحل: نحوّل http://1.2.3.4 إلى
// http://1-2-3-4.sslip.io (اسم نطاق يشير إلى نفس العنوان)، ونتبع التحويلات يدوياً لنطبّق ذلك عليها أيضاً.
export function defaultIpHost(u) {
  if (u.protocol === "http:" && /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) {
    const n = new URL(u.href);
    n.hostname = u.hostname.replace(/\./g, "-") + ".sslip.io";
    return n;
  }
  return u;
}

// بعض السيرفرات تحوّل الطلب من عنوان IP إلى اسم نطاق (مثل xxx.duckdns.org) يرفض طلبات Cloudflare Workers (403)،
// بينما يقبل الاتصال بالعنوان الرقمي نفسه. لذلك نحلّ الاسم عبر DNS-over-HTTPS ونتصل بالعنوان (عبر sslip.io).
const dohCache = new Map();
async function dohIp(host) {
  const hit = dohCache.get(host);
  if (hit && hit.exp > Date.now()) return hit.ip;
  let ip = null;
  try {
    const r = await fetch("https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(host) + "&type=A", { headers: { Accept: "application/dns-json" } });
    const j = await r.json();
    const a = (j.Answer || []).find((x) => x.type === 1 && /^\d{1,3}(\.\d{1,3}){3}$/.test(x.data));
    if (a) ip = a.data;
  } catch (e) { /* نُبقي الاسم كما هو */ }
  dohCache.set(host, { ip, exp: Date.now() + 5 * 60 * 1000 });
  return ip;
}
export async function ipifyHost(u, ipHost) {
  if (u.protocol === "http:" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) && !/\.sslip\.io$/i.test(u.hostname)) {
    const ip = await dohIp(u.hostname);
    if (ip) { const n = new URL(u.href); n.hostname = ip; return ipHost(n); }
  }
  return ipHost(u);
}

async function fetchFollow(url, headers, method, ipHost) {
  let cur = ipHost(new URL(url));
  for (let i = 0; i < 6; i++) {
    const res = await fetch(cur.href, { method, headers, redirect: "manual" });
    const loc = res.headers.get("Location");
    if (res.status >= 300 && res.status < 400 && loc) {
      try { await res.body?.cancel(); } catch (e) { /* ignore */ }
      cur = await ipifyHost(new URL(loc, cur), ipHost);
      continue;
    }
    return { res, url: cur };
  }
  throw new Error("too many redirects");
}


// ───────────────────────── تشخيص آمن للرابط ?u= ─────────────────────────
// يحافظ على أسماء معاملات الرابط لأغراض التشخيص، لكنه يخفي قيمها حتى لا تظهر MAC/token/credentials.
function safeDebugUrl(href) {
  try {
    const u = new URL(href);
    let pathname = u.pathname;

    // نمط شائع في روابط IPTV: /live/<user>/<pass>/<stream>.ts
    // نخفي الجزأين الأوسطين إن وُجدا، لأنهما قد يكونان بيانات دخول.
    const parts = pathname.split("/");
    if (parts.length >= 5 && /^(live|movie|series)$/i.test(parts[1])) {
      parts[2] = "***";
      parts[3] = "***";
      pathname = parts.join("/");
    }

    const keys = [...u.searchParams.keys()];
    const maskedQuery = keys.length
      ? "?" + keys.map((k) => encodeURIComponent(k) + "=***").join("&")
      : "";

    return {
      url: u.origin + pathname + maskedQuery,
      origin: u.origin,
      pathname,
      query_keys: keys,
    };
  } catch (e) {
    return { url: "(invalid URL)", origin: "", pathname: "", query_keys: [] };
  }
}

function debugUParsing(reqUrl, target) {
  const reserved = new Set(["u", "url", "debug", "c", "r", "d"]);
  const outer = [];

  for (const [k, v] of reqUrl.searchParams) {
    if (!reserved.has(k)) outer.push({ key: k, value: "***", length: String(v).length });
  }

  const safe = safeDebugUrl(target || "");
  const malformed = !!target && /^https?:\/\//i.test(target) && outer.length > 0;

  return {
    ok: !malformed,
    mode: "u-debug",
    malformed_u: malformed,
    received_target: safe.url,
    received_origin: safe.origin,
    received_pathname: safe.pathname,
    received_query_keys: safe.query_keys,
    unexpected_outer_params: outer,
    hint: malformed
      ? "The upstream URL was probably not fully encoded. Encode the entire source URL with encodeURIComponent before placing it in ?u=."
      : "No split outer parameters detected. If upstream still returns 403, the rejection is coming from the upstream server rather than URL parsing.",
  };
}


// ───────────────────────── تشخيص HLS / Codec ─────────────────────────

function jsonResponse(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function extensionHintFromUrl(u) {
  try { return (new URL(u).searchParams.get("extension") || "").toLowerCase(); }
  catch (e) { return ""; }
}

function firstPlaylistUris(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let pendingStreamInf = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingStreamInf = true;
      continue;
    }
    if (line.startsWith("#")) continue;
    out.push({ uri: line, variant: pendingStreamInf });
    pendingStreamInf = false;
  }
  return out;
}

async function readPrefix(res, maxBytes = 512 * 1024) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      const take = Math.min(value.length, maxBytes - total);
      chunks.push(value.subarray(0, take));
      total += take;
      if (take < value.length) break;
    }
  } finally {
    try { await reader.cancel(); } catch (e) { /* ignore */ }
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return all;
}

function streamTypeName(t, descriptors) {
  const names = {
    0x01: "MPEG-1 Video",
    0x02: "MPEG-2 Video",
    0x03: "MPEG-1 Audio",
    0x04: "MPEG-2 Audio",
    0x0f: "AAC (ADTS)",
    0x10: "MPEG-4 Visual",
    0x11: "AAC (LATM)",
    0x1b: "H.264 / AVC",
    0x24: "H.265 / HEVC",
    0x27: "H.264 MVC",
    0x2a: "AVS Video",
    0x42: "AVS Video",
    0x81: "AC-3 (commonly)",
    0x87: "E-AC-3 (commonly)",
  };
  if (names[t]) return names[t];

  // stream_type 0x06 = private PES; descriptors may identify AC-3/E-AC-3.
  if (t === 0x06 && descriptors) {
    for (let i = 0; i + 1 < descriptors.length;) {
      const tag = descriptors[i], len = descriptors[i + 1];
      if (tag === 0x6a) return "AC-3";
      if (tag === 0x7a) return "E-AC-3";
      i += 2 + len;
    }
    return "Private PES";
  }
  return "stream_type 0x" + t.toString(16).padStart(2, "0");
}

function isVideoStreamType(t) {
  return [0x01, 0x02, 0x10, 0x1b, 0x24, 0x27, 0x2a, 0x42].includes(t);
}

function isAudioStreamType(t) {
  return [0x03, 0x04, 0x0f, 0x11, 0x81, 0x87].includes(t);
}

function tsPacketOffset(data) {
  // Find a sync position that repeats every 188 bytes.
  const limit = Math.min(188, Math.max(0, data.length - 188 * 3));
  for (let off = 0; off <= limit; off++) {
    if (data[off] === 0x47 &&
        data[off + 188] === 0x47 &&
        data[off + 376] === 0x47) return off;
  }
  return -1;
}

function parseTsCodecs(data) {
  const start = tsPacketOffset(data);
  if (start < 0) return { container: "unknown", reason: "No MPEG-TS sync pattern found." };

  let pmtPid = null;
  const streams = [];
  const seen = new Set();

  for (let off = start; off + 188 <= data.length; off += 188) {
    if (data[off] !== 0x47) continue;

    const pusi = !!(data[off + 1] & 0x40);
    const pid = ((data[off + 1] & 0x1f) << 8) | data[off + 2];
    const afc = (data[off + 3] >> 4) & 0x03;
    if (afc === 0 || afc === 2) continue;

    let pos = off + 4;
    if (afc === 3) {
      const afl = data[pos];
      pos += 1 + afl;
    }
    if (pos >= off + 188) continue;

    if (pusi) {
      const pointer = data[pos];
      pos += 1 + pointer;
    }
    if (pos + 3 > off + 188) continue;

    if (pid === 0 && data[pos] === 0x00) {
      const sectionLen = ((data[pos + 1] & 0x0f) << 8) | data[pos + 2];
      const end = Math.min(pos + 3 + sectionLen - 4, off + 188);
      let p = pos + 8;
      while (p + 4 <= end) {
        const program = (data[p] << 8) | data[p + 1];
        const mapPid = ((data[p + 2] & 0x1f) << 8) | data[p + 3];
        if (program !== 0) { pmtPid = mapPid; break; }
        p += 4;
      }
      continue;
    }

    if (pmtPid !== null && pid === pmtPid && data[pos] === 0x02) {
      const sectionLen = ((data[pos + 1] & 0x0f) << 8) | data[pos + 2];
      const sectionEnd = Math.min(pos + 3 + sectionLen - 4, off + 188);
      if (pos + 12 > sectionEnd) continue;
      const programInfoLen = ((data[pos + 10] & 0x0f) << 8) | data[pos + 11];
      let p = pos + 12 + programInfoLen;

      while (p + 5 <= sectionEnd) {
        const st = data[p];
        const elementaryPid = ((data[p + 1] & 0x1f) << 8) | data[p + 2];
        const esInfoLen = ((data[p + 3] & 0x0f) << 8) | data[p + 4];
        const descStart = p + 5;
        const descEnd = Math.min(descStart + esInfoLen, sectionEnd);
        const descriptors = data.subarray(descStart, descEnd);
        const key = st + ":" + elementaryPid;
        if (!seen.has(key)) {
          seen.add(key);
          const kind = isVideoStreamType(st) ? "video" : isAudioStreamType(st) ? "audio" : "other";
          streams.push({
            pid: elementaryPid,
            stream_type: "0x" + st.toString(16).padStart(2, "0"),
            codec: streamTypeName(st, descriptors),
            kind,
          });
        }
        p = descStart + esInfoLen;
      }

      if (streams.length) break;
    }
  }

  const video = streams.filter((s) => s.kind === "video");
  const audio = streams.filter((s) => s.kind === "audio");
  return {
    container: "MPEG-TS",
    pmt_pid: pmtPid,
    streams,
    video,
    audio,
  };
}

async function fetchTextFollowing(url, headers, ipHost) {
  const r = await fetchFollow(url, headers, "GET", ipHost);
  if (!r.res.ok) return { ok: false, status: r.res.status, url: r.url.href, text: "" };
  return { ok: true, status: r.res.status, url: r.url.href, text: await r.res.text(), contentType: r.res.headers.get("Content-Type") || "" };
}

async function diagnoseCodec(playlistText, playlistUrl, upstreamHeaders, ipHost) {
  let currentText = playlistText;
  let currentUrl = playlistUrl;
  const path = [];

  // Follow up to two nested variant playlists.
  for (let depth = 0; depth < 3; depth++) {
    const items = firstPlaylistUris(currentText);
    if (!items.length) {
      return { ok: false, stage: "playlist", error: "No media URI found in playlist.", playlist_depth: depth, path };
    }

    const variant = items.find((x) => x.variant);
    if (!variant) {
      const segUrl = new URL(items[0].uri, currentUrl).href;
      path.push({ type: "segment", host: new URL(segUrl).host, pathname: new URL(segUrl).pathname });

      const r = await fetchFollow(segUrl, upstreamHeaders, "GET", ipHost);
      if (!r.res.ok && r.res.status !== 206) {
        return { ok: false, stage: "segment", status: r.res.status, path };
      }

      const ct = r.res.headers.get("Content-Type") || "";
      const data = await readPrefix(r.res, 512 * 1024);
      const parsed = parseTsCodecs(data);

      return {
        ok: true,
        mode: "codec-debug",
        playlist_depth: depth,
        segment_content_type: ct,
        bytes_inspected: data.length,
        ...parsed,
        path,
        note: parsed.container === "MPEG-TS"
          ? "Codec names were read from the MPEG-TS PMT table; the stream was not transcoded."
          : "The first media object did not look like MPEG-TS. It may be fMP4/CMAF or another container.",
      };
    }

    const nextUrl = new URL(variant.uri, currentUrl).href;
    path.push({ type: "playlist", host: new URL(nextUrl).host, pathname: new URL(nextUrl).pathname });
    const next = await fetchTextFollowing(nextUrl, upstreamHeaders, ipHost);
    if (!next.ok) {
      return { ok: false, stage: "variant-playlist", status: next.status, path };
    }
    currentUrl = next.url;
    currentText = next.text;
  }

  return { ok: false, stage: "playlist", error: "Too many nested playlists.", path };
}

export async function handle(request, targets = ALLOWED_TARGETS, origins = ALLOWED_ORIGINS, ipHost = defaultIpHost, channels = {}, resolve = null, discover = null) {
  const reqUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  const cors = {
    "Access-Control-Allow-Origin": origins.includes(origin) ? origin : origins[0],
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
    "Vary": "Origin",
  };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405, headers: cors });

  const cid = reqUrl.searchParams.get("c");
  const rid = reqUrl.searchParams.get("r");
  let target = reqUrl.searchParams.get("u") || reqUrl.searchParams.get("url");

  // عند debug=1 مع ?u= نعرض كيف فُسّر الرابط فعليًا، قبل الاتصال بالسيرفر المصدر.
  // هذا يكشف أخطاء مثل وضع &stream=... خارج قيمة u بسبب نسيان encodeURIComponent.
  if (target && reqUrl.searchParams.get("debug") === "1") {
    const diag = debugUParsing(reqUrl, target);
    return new Response(JSON.stringify(diag, null, 2), {
      status: diag.malformed_u ? 400 : 200,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // حماية: إن جاء الطلب من موقع آخر غير موقعك يُرفض (يمنع المواقع الأخرى من استعمال وسيطك)
  if (rid && origin && !origins.includes(origin)) return new Response("PROXY: origin not allowed: " + origin, { status: 403, headers: cors });

  // اكتشاف معرّف ok.ru: يرجع JSON فقط (لا يمرّر بثًّا)
  const did = reqUrl.searchParams.get("d");
  if (did) {
    const jsonHeaders = { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" };
    if (origin && !origins.includes(origin)) return new Response("PROXY: origin not allowed: " + origin, { status: 403, headers: cors });
    if (!discover) return new Response("PROXY: discovery not enabled", { status: 501, headers: cors });
    const debug = !!reqUrl.searchParams.get("debug");
    let d;
    try { d = await discover(did, { force: debug }); }
    catch (e) { return new Response(JSON.stringify({ ok: false, error: e.message }), { status: e.stage === "id" ? 404 : 502, headers: jsonHeaders }); }
    const body = {
      ok: d.source !== "fallback", id: d.id, embed: "https://ok.ru/videoembed/" + d.id,
      source: d.source, stale: d.source === "fallback", age_s: Math.round((Date.now() - d.at) / 1000),
    };
    if (debug) { body.kind = d.kind; body.candidates = d.candidates; body.trace = d.trace; body.page = d.page; }
    return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders });
  }

  let freshResolved = null;
  if (rid) {
    // وضع الاستخراج عند الطلب. بلا u: نبدأ من رابط القناة المستخرج. مع u: وسيط لمقاطع هذه القناة مع تجديد الـ token عند الحاجة.
    if (!resolve) return new Response("PROXY: resolver not enabled", { status: 501, headers: cors });
    try { freshResolved = await resolve(rid, false); }
    catch (e) {
      if (reqUrl.searchParams.get("debug")) return new Response(JSON.stringify({ ok: false, stage: e.stage || "unknown", error: e.message }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
      return new Response("PROXY: could not resolve channel " + rid + " (" + (e.stage || "error") + ")", { status: e.stage === "id" ? 404 : 502, headers: cors });
    }
    if (reqUrl.searchParams.get("debug")) {
      return new Response(JSON.stringify({ ok: true, stage: "done", url: maskUrl(freshResolved.url), age_s: Math.round((Date.now() - freshResolved.at) / 1000) }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (!target) target = freshResolved.url;
  } else if (cid) {
    const entry = Object.prototype.hasOwnProperty.call(channels, cid) ? channels[cid] : null;
    target = entry && (typeof entry === "string" ? entry : entry.url);
    if (!target) return new Response("PROXY: unknown channel '" + cid + "'", { status: 404, headers: cors });
  }
  if (!target) return new Response("PITA proxy OK", { status: 200, headers: cors });
  // في وضع القناة المحمية لا نكشف اسم السيرفر ولا الرابط في رسائل الخطأ
  const who = (host) => (cid ? "channel " + cid : rid ? "channel " + rid : host);

  let t;
  try { t = new URL(target); } catch { return new Response("Bad url", { status: 400, headers: cors }); }
  if (t.protocol !== "http:" && t.protocol !== "https:")
    return new Response("Bad protocol", { status: 400, headers: cors });
  // حماية: إن جاء الطلب من موقع آخر غير موقعك يُرفض (يمنع المواقع الأخرى من استعمال وسيطك)
  if (origin && !origins.includes(origin)) return new Response("PROXY: origin not allowed: " + origin, { status: 403, headers: cors });
  if (!cid && !rid && !targets.includes("*") && !targets.includes(t.host)) return new Response("PROXY: target not allowed: " + t.host, { status: 403, headers: cors });

  const upstreamHeaders = {};
  const range = request.headers.get("Range");
  if (range) upstreamHeaders["Range"] = range;

  // بعض سيرفرات IPTV ترفض User-Agent المتصفحات وتقبل مشغّلات مثل VLC
  // أما قنوات ?r= فنستعمل نفس User-Agent الذي نجح عند استخراجها
  upstreamHeaders["User-Agent"] = rid ? RESOLVER_UA : UPSTREAM_UA;
  upstreamHeaders["Accept"] = "*/*";

  let upstream, finalUrl;
  try {
    let r = await fetchFollow(t.href, upstreamHeaders, request.method, ipHost);
    // token انتهى أو رُفض: نستخرج رابطًا جديدًا مرة واحدة ونعيد المحاولة
    if (rid && (r.res.status === 401 || r.res.status === 403)) {
      try { await r.res.body?.cancel(); } catch (e) { /* ignore */ }
      let again = null;
      try { again = await resolve(rid, true); } catch (e) { /* نُبقي الرد الأول */ }
      if (again) {
        const retryHref = reqUrl.searchParams.get("u") ? refreshToken(t.href, again.url) : again.url;
        freshResolved = again;
        r = await fetchFollow(retryHref, upstreamHeaders, request.method, ipHost);
      }
    }
    upstream = r.res;
    finalUrl = r.url.href;
  } catch (e) {
    return new Response("PROXY: could not reach " + who(t.host) + " (" + e.message + ")", { status: 502, headers: cors });
  }
  if (!upstream.ok && upstream.status !== 206) {
    const finalHost = new URL(finalUrl).host;
    const note = !cid && !rid && finalHost !== t.host ? " (redirected from " + t.host + ")" : "";
    // نص الخطأ الذي أرسله السيرفر (إن وُجد) يساعد في معرفة السبب
    let snippet = "";
    try {
      const ct2 = upstream.headers.get("Content-Type") || "";
      if (!ct2 || /text|json|html|xml/i.test(ct2)) {
        snippet = (await upstream.text()).replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      }
    } catch (e) { /* ignore */ }
    const msg = "PROXY: upstream " + who(finalHost) + " answered " + upstream.status + note +
      (upstream.headers.get("Server") ? " | server: " + upstream.headers.get("Server") : "") +
      (snippet ? " | body: " + snippet : " | body: (empty)");
    return new Response(msg, { status: upstream.status, headers: cors });
  }
  const headers = new Headers(cors);
  const ct = upstream.headers.get("Content-Type") || "";
  const extensionHint = extensionHintFromUrl(t.href);
  let isPlaylist = /mpegurl/i.test(ct) || /\.m3u8?$/i.test(t.pathname);

  // live.php?...&extension=m3u8 شائع في IPTV، وقد يرسل بعض الخوادم Content-Type غير دقيق.
  let body = upstream.body;
  let peekedText = null;
  const shouldSniff = !isPlaylist && upstream.ok && request.method === "GET" && upstream.status === 200 && body &&
    (extensionHint === "m3u8" || !/^(video|audio|image)\//i.test(ct));

  if (shouldSniff) {
    const peek = await peekBody(upstream);
    if (peek.playlist !== null) { isPlaylist = true; peekedText = peek.playlist; }
    else body = peek.stream;
  }

  const debugMode = reqUrl.searchParams.get("debug") || "";

  if (debugMode === "stream") {
    const safe = safeDebugUrl(finalUrl);
    return jsonResponse({
      ok: true,
      mode: "stream-debug",
      upstream_status: upstream.status,
      content_type: ct,
      content_length: upstream.headers.get("Content-Length"),
      accept_ranges: upstream.headers.get("Accept-Ranges"),
      extension_hint: extensionHint,
      sniffed: shouldSniff,
      detected_playlist: isPlaylist,
      final_url: safe.url,
      final_origin: safe.origin,
      final_pathname: safe.pathname,
      final_query_keys: safe.query_keys,
      note: isPlaylist
        ? "The upstream response is being treated as HLS/M3U8."
        : "The upstream response is being passed through as a media stream.",
    }, cors);
  }

  if (isPlaylist && upstream.ok) {
    const text = peekedText !== null ? peekedText : await upstream.text();

    if (debugMode === "codec") {
      const diag = await diagnoseCodec(text, finalUrl, upstreamHeaders, ipHost);
      return jsonResponse(diag, cors, diag.ok ? 200 : 502);
    }

    const self = reqUrl.origin + reqUrl.pathname;
    headers.set("Content-Type", "application/vnd.apple.mpegurl");
    headers.set("Cache-Control", "no-store");
    return new Response(rewritePlaylist(text, finalUrl, self, rid ? { rid } : undefined), { status: 200, headers });
  }

  if (debugMode === "codec") {
    return jsonResponse({
      ok: false,
      mode: "codec-debug",
      stage: "not-hls",
      content_type: ct,
      extension_hint: extensionHint,
      error: "The upstream response was not detected as an HLS playlist, so no HLS segment could be inspected.",
    }, cors, 422);
  }

  for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(body, { status: upstream.status, headers });
}

// يقرأ أول جزء من الرد: إن كان قائمة #EXTM3U يقرؤه كاملاً ويعيده نصًّا، وإلا يعيد stream جديدًا يبدأ بنفس الجزء ثم يكمل البثّ.
export async function peekBody(res) {
  const reader = res.body.getReader();
  const first = await reader.read();
  const chunk = first.value || new Uint8Array(0);
  const head = new TextDecoder().decode(chunk.subarray(0, 16)).replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("#EXTM3U")) {
    const parts = [chunk];
    let total = chunk.length;
    while (!first.done) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); total += value.length;
      if (total > 5_000_000) break;   // قائمة تشغيل حقيقية لا تكبر هكذا
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    return { playlist: new TextDecoder().decode(all), stream: null };
  }
  const stream = new ReadableStream({
    start(c) { if (chunk.length) c.enqueue(chunk); if (first.done) c.close(); },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close(); else c.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { playlist: null, stream };
}

// opts.rid: وضع ?r= — الروابط الداخلية تحمل معرّف القناة (لتجديد الـ token عند انتهائه)،
// ويُنسخ استعلام قائمة التشغيل (token) إلى الروابط النسبية التي بلا استعلام من نفس السيرفر.
export function rewritePlaylist(text, base, self, opts) {
  const rid = opts && opts.rid;
  const baseUrl = new URL(base);
  const wrap = (u) => {
    const abs = new URL(u, base);
    if (rid && abs.host === baseUrl.host && !abs.search && baseUrl.search) abs.search = baseUrl.search;
    return self + "?" + (rid ? "r=" + encodeURIComponent(rid) + "&" : "") + "u=" + encodeURIComponent(abs.href);
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${wrap(u)}"`);
      return wrap(line.trim());
    })
    .join("\n");
}

// مثيل واحد لكل isolate: الكاش داخل الذاكرة يبقى بين الطلبات ما دام الـ isolate حيًّا
const resolver = makeResolver();
const discoverer = makeDiscoverer();

export default {
  fetch: (request, env) => {
    let channels = {};
    try { channels = JSON.parse((env && env.CHANNELS) || "{}"); } catch (e) { /* سرّ غير صالح */ }
    const envId = (env && env.DUHOK_ID) || "";   // متغيّر اختياري في Cloudflare: معرّف يدوي إن فشل الاكتشاف
    return handle(request, ALLOWED_TARGETS, ALLOWED_ORIGINS, defaultIpHost, channels, resolver,
      (did, opts) => discoverer(did, { ...opts, envId }));
  },
};
