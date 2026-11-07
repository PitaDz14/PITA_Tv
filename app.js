/* ===== بناء البطاقات من channels.js (لا تعدّل هنا؛ عدّل channels.js) ===== */
(function () {
  var GENERAL = ['algerian', 'moroccan', 'egyptian', 'palestinian', 'tunisian', 'french', 'saudi', 'iraqi'];
  var SECTIONS = ['news', 'sports', 'sports_fr', 'sports_other', 'islamic', 'docs', 'kids'];
  var RAIL_ORDER = [
    { id: 'algerian', title: 'قنوات جزائرية', cat: 'general', sub: 'algerian' },
    { id: 'sports', title: 'رياضة', cat: 'sports' },
    { id: 'news', title: 'أخبار', cat: 'news' },
    { id: 'egyptian', title: 'قنوات مصرية', cat: 'general', sub: 'egyptian' },
    { id: 'saudi', title: 'سعودية', cat: 'general', sub: 'saudi' },
    { id: 'iraqi', title: 'عراقية', cat: 'general', sub: 'iraqi' },
    { id: 'islamic', title: 'إسلامية', cat: 'islamic' },
    { id: 'kids', title: 'أطفال', cat: 'kids' },
    { id: 'french', title: 'فرنسية', cat: 'general', sub: 'french' },
    { id: 'docs', title: 'وثائقية', cat: 'docs' }
  ];
  var errors = (window.__chErr || []).slice();
  window.__PITA_META = { GENERAL: GENERAL, SECTIONS: SECTIONS, byTitle: {}, list: [] };

  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ') + "'"; }
  function expr(u) { return /^\{proxy\}/.test(u) ? 'PROXY_BASE + ' + q(u.slice(7)) : q(u); }

  function onclickOf(c) {
    var title = c.title || c.name;
    if (c.type === 'open') return 'window.open(' + q(c.url) + ", '_blank', 'noopener,noreferrer')";
    if (c.servers) {
      return 'playChannel(' + q(title) + ', [' + c.servers.map(function (s) {
        return '{name:' + q(s.name || '') + ',url:' + expr(s.url) + (s.type ? ',type:' + q(s.type) : '') + '}';
      }).join(',') + '])';
    }
    if (!c.url) return 'playFrench(' + q(title) + ", '')";
    return 'playChannel(' + q(title) + ', ' + expr(c.url) + (c.type ? ', ' + q(c.type) : '') + ')';
  }

  function validate(c, i) {
    var who = 'القناة رقم ' + (i + 1) + (c && c.name ? ' («' + c.name + '»)' : '');
    if (!c || typeof c !== 'object') return who + ': ليست سطر قناة صحيحاً';
    if (!c.name || typeof c.name !== 'string') return who + ': ينقصها name';
    if (!Array.isArray(c.groups) || !c.groups.length) return who + ': ينقصها groups';
    var bad = c.groups.filter(function (g) { return GENERAL.indexOf(g) < 0 && SECTIONS.indexOf(g) < 0; });
    if (bad.length) return who + ': مجموعة غير معروفة «' + bad.join('، ') + '»';
    if (c.servers) {
      if (!Array.isArray(c.servers) || !c.servers.length || c.servers.some(function (s) { return !s || typeof s.url !== 'string' || !s.url; }))
        return who + ': servers غير صحيحة (لكل سيرفر url)';
    } else if (c.url != null && typeof c.url !== 'string') return who + ': url يجب أن يكون نصاً بين علامتَي اقتباس';
    return null;
  }

  function initials(name) {
    var t = String(name || '').replace(/[^\u0600-\u06FFa-zA-Z0-9]+/g, ' ').trim();
    if (!t) return 'TV';
    var parts = t.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).slice(0, 2);
    return t.slice(0, 2);
  }

  function makeCard(c, group) {
    var card = document.createElement('div');
    var title = c.title || c.name;
    card.className = 'channel-card' + (GENERAL.indexOf(group) > -1 ? ' ' + group : '');
    card.style.setProperty('--accent', 'var(--g-' + group + ', var(--green))');
    card.setAttribute('onclick', onclickOf(c));
    card.dataset.group = group;
    card.dataset.title = title;
    card.dataset.name = c.name;

    var av = document.createElement('div');
    av.className = 'channel-avatar';
    av.setAttribute('aria-hidden', 'true');
    if (c.logo) {
      var img = document.createElement('img');
      img.src = c.logo; img.alt = ''; img.loading = 'lazy';
      img.onerror = function () { av.textContent = initials(c.name); img.remove(); };
      av.appendChild(img);
    } else if (c.icon) {
      av.innerHTML = '<i class="fas fa-' + c.icon + ' fa-icon"></i>';
    } else {
      av.textContent = initials(c.name);
    }

    var nm = document.createElement('div'); nm.className = 'channel-name'; nm.textContent = c.name;
    var ov = document.createElement('div'); ov.className = 'play-overlay';
    ov.innerHTML = '<div class="play-btn"><i class="fas fa-play"></i></div>';
    card.appendChild(av); card.appendChild(nm); card.appendChild(ov);
    return card;
  }

  function buildHomeRails(validChannels) {
    var host = document.getElementById('home-rails');
    if (!host) return;
    host.innerHTML = '';
    RAIL_ORDER.forEach(function (rail) {
      var items = validChannels.filter(function (c) { return c.groups.indexOf(rail.id) > -1; });
      if (!items.length) return;
      var wrap = document.createElement('section');
      wrap.className = 'rail';
      wrap.dataset.rail = rail.id;
      var head = document.createElement('div');
      head.className = 'rail-head';
      head.innerHTML = '<h3>' + rail.title + '</h3>';
      var more = document.createElement('button');
      more.type = 'button'; more.className = 'rail-more'; more.textContent = 'عرض الكل';
      more.onclick = function () {
        filterCategory(rail.cat || rail.id);
        if (rail.sub) filterSub(rail.sub);
      };
      head.appendChild(more);
      var track = document.createElement('div');
      track.className = 'rail-track';
      items.slice(0, 18).forEach(function (c) { track.appendChild(makeCard(c, rail.id)); });
      wrap.appendChild(head); wrap.appendChild(track);
      host.appendChild(wrap);
    });
  }

  var valid = [];
  if (typeof CHANNELS === 'undefined' || !Array.isArray(CHANNELS)) {
    errors.push('ملف channels.js لم يُحمَّل أو فيه خطأ في الكتابة (قوس أو فاصلة ناقصة).');
  } else {
    CHANNELS.forEach(function (c, i) {
      var err = validate(c, i);
      if (err) { errors.push(err); return; }
      valid.push(c);
      var meta = { name: c.name, title: c.title || c.name, groups: c.groups.slice(), onclick: onclickOf(c), logo: c.logo || '', icon: c.icon || '' };
      window.__PITA_META.list.push(meta);
      window.__PITA_META.byTitle[meta.title] = meta;
      c.groups.forEach(function (g) {
        var host = document.getElementById(GENERAL.indexOf(g) > -1 ? 'general-grid' : 'grid-' + g);
        if (host) host.appendChild(makeCard(c, g));
      });
    });
    buildHomeRails(valid);
  }

  if (errors.length) {
    console.error('[channels.js]', errors);
    var bar = document.createElement('div');
    bar.setAttribute('dir', 'rtl');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b00020;color:#fff;font:600 13px/1.6 sans-serif;padding:8px 14px;max-height:40vh;overflow:auto;cursor:pointer';
    bar.innerHTML = '⚠ أخطاء في channels.js (اضغط للإخفاء):<br>' + errors.map(function (e) { return '• ' + String(e).replace(/</g, '&lt;'); }).join('<br>');
    bar.onclick = function () { bar.remove(); };
    document.body.appendChild(bar);
  }
})();


// Category Filtering
    function setActiveBtn(selector, key) {
      const btns = [...document.querySelectorAll(selector)];
      btns.forEach(b => b.classList.remove('active'));
      const b = btns.find(x => (x.getAttribute('onclick') || '').includes("'" + key + "'") || x.getAttribute('data-cat') === key);
      if (b) b.classList.add('active');
    }

    function syncBottomNav(catId) {
      const map = { home: 'home', sports: 'sports', news: 'news', favs: 'favs' };
      const key = map[catId] || 'more';
      document.querySelectorAll('#bottomNav .bn-item').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-cat') === key);
      });
    }

    function closeMore() {
      const sheet = document.getElementById('moreSheet');
      if (sheet) sheet.hidden = true;
    }

    var MATCH_LEADS = {
      live: 'مواعيد المباريات وروابط المشاهدة لليوم — اسحب الإطار لأسفل لرؤية كل المباريات.',
      sat: 'دليل القنوات الناقلة عبر السات، مع النتائج والإحصائيات — اسحب لأسفل لاستعراض الدليل كاملًا.'
    };

    function activeMatchPane() {
      var tab = document.querySelector('.matches-tabs .sub-btn.active');
      return (tab && tab.getAttribute('data-match-tab')) || 'live';
    }

    function matchesStageEl(pane) {
      return document.getElementById(pane === 'sat' ? 'matchesStageSat' : 'matchesStageLive');
    }

    function matchesFrameEl(pane) {
      return document.getElementById(pane === 'sat' ? 'matchesFrameSat' : 'matchesFrameLive');
    }

    function loadMatchesFrame(pane) {
      pane = pane || activeMatchPane();
      const frame = matchesFrameEl(pane);
      const stage = matchesStageEl(pane);
      if (!frame || !stage) return;
      if (!frame.getAttribute('src') && frame.dataset.src) {
        stage.classList.remove('is-ready');
        frame.src = frame.dataset.src;
        frame.addEventListener('load', function () { stage.classList.add('is-ready'); }, { once: true });
        setTimeout(function () { stage.classList.add('is-ready'); }, 10000);
      } else {
        stage.classList.add('is-ready');
      }
    }

    function switchMatchTab(pane) {
      pane = pane === 'sat' ? 'sat' : 'live';
      document.querySelectorAll('.matches-tabs .sub-btn').forEach(function (b) {
        var on = b.getAttribute('data-match-tab') === pane;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('.matches-stage').forEach(function (st) {
        var on = st.getAttribute('data-match-pane') === pane;
        st.hidden = !on;
        st.classList.toggle('is-active', on);
        if (!on) st.classList.remove('is-expanded');
      });
      var lead = document.getElementById('matchesLead');
      if (lead) lead.textContent = MATCH_LEADS[pane] || MATCH_LEADS.live;
      document.body.classList.remove('matches-expanded');
      var btn = document.getElementById('matchesExpandBtn');
      if (btn) btn.innerHTML = '<i class="fas fa-expand"></i> تكبير الإطار';
      loadMatchesFrame(pane);
    }
    window.switchMatchTab = switchMatchTab;

    function setMatchesExpanded(on) {
      const stage = matchesStageEl(activeMatchPane());
      const btn = document.getElementById('matchesExpandBtn');
      if (!stage || stage.hidden) return;
      stage.classList.toggle('is-expanded', !!on);
      document.body.classList.toggle('matches-expanded', !!on);
      if (btn) {
        btn.innerHTML = on
          ? '<i class="fas fa-compress"></i> تصغير الإطار'
          : '<i class="fas fa-expand"></i> تكبير الإطار';
      }
    }

    function filterCategory(catId) {
      closeMore();
      document.body.classList.remove('search-open');
      if (catId !== 'matches') setMatchesExpanded(false);
      setActiveBtn('.nav-btn', catId);
      syncBottomNav(catId);
      document.querySelectorAll('.category-section').forEach(sec => sec.classList.remove('active'));
      const activeSec = document.getElementById(catId);
      if (activeSec) activeSec.classList.add('active');
      if (catId === 'matches') loadMatchesFrame();
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
    }
    window.filterCategory = filterCategory;
    window.closeMore = closeMore;

    function filterSub(subClass) {
      setActiveBtn('.sub-btn', subClass);
      document.querySelectorAll('#general-grid .channel-card').forEach(item => {
        item.style.display = item.classList.contains(subClass) ? 'flex' : 'none';
      });
    }
    window.filterSub = filterSub;

    // Search Functionality
    document.getElementById('searchInput').addEventListener('input', function (e) {
      const term = e.target.value.trim().toLowerCase();
      const allCards = document.querySelectorAll('.category-section:not(#favs):not(#home):not(#matches) .channel-card');

      if (term) {
        document.body.classList.add('searching');
        document.querySelectorAll('.category-section')
          .forEach(s => s.classList.toggle('active', s.id !== 'favs' && s.id !== 'matches' && s.id !== 'home'));
        allCards.forEach(card => {
          const el = card.querySelector('.channel-name');
          card.style.display = (el && el.textContent.toLowerCase().includes(term)) ? 'flex' : 'none';
        });
      } else {
        document.body.classList.remove('searching');
        allCards.forEach(c => c.style.display = 'flex');
        filterCategory('home');
        filterSub('algerian');
      }
    });

    var searchToggle = document.getElementById('searchToggle');
    if (searchToggle) {
      searchToggle.addEventListener('click', function () {
        document.body.classList.toggle('search-open');
        if (document.body.classList.contains('search-open')) {
          var si = document.getElementById('searchInput'); if (si) si.focus();
        }
      });
    }
    var moreBtn = document.getElementById('moreNavBtn');
    if (moreBtn) {
      moreBtn.addEventListener('click', function () {
        var sheet = document.getElementById('moreSheet');
        if (sheet) sheet.hidden = !sheet.hidden;
      });
    }
    var matchesExpandBtn = document.getElementById('matchesExpandBtn');
    if (matchesExpandBtn) {
      matchesExpandBtn.addEventListener('click', function () {
        var stage = matchesStageEl(activeMatchPane());
        var on = !(stage && stage.classList.contains('is-expanded'));
        loadMatchesFrame();
        setMatchesExpanded(on);
      });
    }
    document.querySelectorAll('.matches-tabs [data-match-tab]').forEach(function (b) {
      b.addEventListener('click', function () { switchMatchTab(b.getAttribute('data-match-tab')); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('matches-expanded')) setMatchesExpanded(false);
    });

    // Player Logic
    // رابط الوسيط HTTPS (Cloudflare Worker) — ضع هنا رابط الـ Worker الخاص بك بعد النشر
    const PROXY_BASE = 'https://pita-proxy.khaled26101992.workers.dev/';
    // الوسيط الثاني (خارج Cloudflare): خادم Docker على VPS/حاسوبك (مجلد docker/) — أو أي وسيط آخر.
    // يُستعمل للسيرفرات التي ترفض Cloudflare بخطأ 403، ولتحويل الصوت MP2→AAC. Cloudflare يبقى الأساس لباقي القنوات.
    // (الرابط الحالي هو وسيط Deno القديم وهو معلَّق ← استبدله برابط خادمك بعد تشغيله)
    // اجعلها true فقط إذا كان الوسيط الثاني هو خادم docker/ (ffmpeg موجود فيه)؛ عندها تُحوَّل القنوات ذات الصوت غير المدعوم تلقائيًا.
    const ALT_SUPPORTS_AAC = false;
    const ALT_BASE = 'https://comfortable-lamprey-2251.pitadz14.deno.net/';
    // سيرفرات تُرسَل مباشرة إلى الوسيط الثاني. فارغة مؤقتًا لأن الوسيط الثاني (Deno) معلَّق؛ بعد تشغيل خادمك أعدها:
    // const ALT_HOSTS = ['131.123.40.197', '185.149.233.33', 'duckdns.org'];
    const ALT_HOSTS = [];
    function needsAlt(url) {
      try { const h = new URL(url).hostname; return ALT_HOSTS.some((d) => h === d || h.endsWith('.' + d)); }
      catch (e) { return false; }
    }
    // ===== تشغيل بث TS المباشر (روابط تنتهي بـ .ts) عبر مكتبة mpegts.js =====
    let tsPlayer = null;
    function loadMpegts() {
      if (window.mpegts) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = 'vendor/mpegts.js';
        sc.onload = resolve;
        sc.onerror = reject;
        document.head.appendChild(sc);
      });
    }

    // ===== القنوات الفرنسية: الرابط داخل البطاقة نفسها، والتشغيل عبر المشغّل الحالي =====
    function frenchNotice(title, text, pageUrl) {
      // يفتح النافذة بلا مشغّل ويعرض رسالة واضحة (+ زر فتح صفحة المصدر في تبويب مستقل، دون تضمينها)
      srvReset();
      const modal = document.getElementById('videoModal');
      const container = document.getElementById('playerContainer');
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('loadingSpinner').style.display = 'none';
      destroyTsPlayer();
      try { if (window.jwplayer && window.jwplayer('playerElement').remove) window.jwplayer('playerElement').remove(); } catch (e) { }
      const old = container.querySelector('iframe'); if (old) old.remove();
      container.querySelectorAll('.open-source-btn').forEach((b) => b.remove());
      if (!document.getElementById('playerElement')) {
        const d = document.createElement('div'); d.id = 'playerElement'; container.appendChild(d);
      }
      showPlayerMsg(text);
      if (pageUrl) {
        const a = document.createElement('a');
        a.className = 'open-source-btn';
        a.href = pageUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = 'فتح صفحة المصدر في تبويب جديد ↗';
        a.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:10px;z-index:9;padding:7px 14px;' +
          'border-radius:20px;background:rgba(0,0,0,.78);border:1px solid rgba(255,255,255,.3);color:#fff;' +
          'font:600 .8rem/1.4 sans-serif;text-decoration:none;white-space:nowrap';
        container.appendChild(a);
      }
      modal.style.display = 'flex';
    }
    // playFrench(الاسم, رابط_البث, النوع): ضع الرابط المرخّص في الوسيط الثاني داخل onclick للبطاقة (النوع الاختياري: 'ts' لروابط .ts)
    function playFrench(name, url, type) {
      url = (url || '').trim();
      if (!/^https?:\/\//i.test(url)) { frenchNotice(name, 'هذه القناة غير مفعّلة بعد: لا يوجد رابط بث مُعدّ لها.'); return; }
      playChannel(name, url, type);
    }

    // ===== رسالة خطأ واضحة فوق المشغّل + تشخيص تلقائي لسبب فشل بثّ TS =====
    function clearPlayerMsg() {
      const m = document.getElementById('playerMsg');
      if (m) m.remove();
    }
    function showPlayerMsg(text) {
      clearPlayerMsg();
      const container = document.getElementById('playerContainer');
      if (!container) return;
      const m = document.createElement('div');
      m.id = 'playerMsg';
      m.style.cssText = 'position:absolute;left:12px;right:12px;bottom:56px;z-index:8;padding:10px 14px;border-radius:10px;' +
        'background:rgba(0,0,0,.82);border:1px solid rgba(255,255,255,.2);color:#fff;font:600 .85rem/1.6 sans-serif;direction:rtl;text-align:right;pointer-events:none';
      m.textContent = text;
      container.appendChild(m);
    }
    function printable(u8) {
      return new TextDecoder().decode(u8).replace(/[^\x20-\x7E؀-ۿ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    }
    // يطلب البث مرة أخرى عبر الوسيط ويقرأ أول بايتات منه ليعرف: هل هو HLS؟ TS سليم؟ أم خطأ من السيرفر؟
    async function diagnoseTsFailure(title, origUrl, proxied, t, d, info, mediaInfo, fallbackDone, usedAlt, type, att) {
      if (srvStale(att)) return;                                  // أُلغيت المحاولة (تحويل/قناة جديدة/إغلاق)
      if (!document.getElementById('tsVideo')) return;           // أُغلقت النافذة
      try { if (tsPlayer) tsPlayer.unload(); } catch (e) { }       // نحرّر اتصال المشغّل أولًا (بعض السيرفرات تسمح باتصال واحد)
      let note;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 12000);
        const r = await fetch(proxied, { signal: ac.signal });
        const reader = r.body ? r.body.getReader() : null;
        const first = reader ? (await reader.read()).value || new Uint8Array(0) : new Uint8Array(0);
        try { ac.abort(); } catch (e) { }
        clearTimeout(timer);
        const txt = printable(first.subarray(0, 600));
        if (srvStale(att)) return;
        if (!r.ok && r.status === 403 && !usedAlt && proxied.startsWith(PROXY_BASE) && /^http:\/\//i.test(origUrl)) {
          showPlayerMsg('السيرفر يرفض Cloudflare (403) — أجرّب الوسيط الثاني تلقائيًا…');
          playEngine(title, origUrl, type || 'ts', fallbackDone, true);
          return;
        }
        if (!r.ok) {
          note = 'السيرفر ردّ بخطأ HTTP ' + r.status + (txt ? ' — ' + txt : '') +
            '. (403/404/458/884 غالبًا: السيرفر يرفض عناوين Cloudflare أو الاشتراك منتهٍ أو الاتصالات ممتلئة)';
        } else if (/^#EXTM3U/.test(txt) && !fallbackDone) {
          showPlayerMsg('الرابط قائمة HLS وليس TS — أبدّل المشغّل تلقائيًا…');
          playEngine(title, origUrl, 'hls', true, usedAlt);
          return;
        } else if (first[0] === 0x47) {
          const codecs = mediaInfo ? ' (فيديو: ' + (mediaInfo.videoCodec || '؟') + ' / صوت: ' + (mediaInfo.audioCodec || '؟') + ')' : '';
          note = 'البثّ يصل سليمًا لكن المتصفح لا يستطيع فك ترميزه' + codecs +
            '. السبب الغالب: ترميز صوت غير مدعوم في المتصفح (MP2 أو AC3/EAC3) أو فيديو HEVC — جرّب نسخة أخرى من القناة.';
        } else {
          note = 'الرد ليس بثًّا صالحًا: ' + (txt || '(فارغ)') + ' — [' + (r.headers.get('Content-Type') || 'بدون نوع') + ']';
        }
      } catch (e) {
        note = e.name === 'AbortError'
          ? 'لم يصل أي ردّ من الوسيط/السيرفر خلال 12 ثانية — قد يكون الاتصال محجوزًا بتشغيل آخر لنفس القناة، أو السيرفر بطيء.'
          : 'تعذّر الاتصال بالوسيط/السيرفر (' + e.message + ').';
      }
      if (srvStale(att)) return;
      if (srvFail(att, 'ts-diagnose', note)) return;              // سيرفر آخر متاح ⇒ تحويل تلقائي بدل عرض الرسالة
      showPlayerMsg('⚠ ' + note + '  [' + (d || t) + (info && info.msg ? ': ' + String(info.msg).slice(0, 80) : '') + ']');
    }
    function destroyTsPlayer() {
      try {
        if (tsPlayer) {
          tsPlayer.pause(); tsPlayer.unload();
          tsPlayer.detachMediaElement(); tsPlayer.destroy();
        }
      } catch (e) { }
      tsPlayer = null;
      const v = document.getElementById('tsVideo');
      if (v) v.remove();
    }

    // أي رابط http://...m3u8 أو ...ts يمرّ تلقائياً عبر الوسيط ليعمل على HTTPS — لا حاجة لأي تعديل إضافي
    function autoProxy(url, force, useAlt, aac) {
      // قناة اشتراك محمية: ch:المعرّف  ← الرابط الحقيقي محفوظ في سرّ الـ Worker وليس في هذا الملف
      if (/^ch:/i.test(url)) return PROXY_BASE + '?c=' + encodeURIComponent(url.slice(3));
      if (aac && /^https?:\/\//i.test(url)) return ALT_BASE + '?aac=1&u=' + encodeURIComponent(url);
      return (/^http:\/\//i.test(url) && (force || /\.m3u8/i.test(url) || /\.ts(\?|#|$)/i.test(url)))
        ? ((useAlt || needsAlt(url)) ? ALT_BASE : PROXY_BASE) + '?u=' + encodeURIComponent(url)
        : url;
    }

    // ===== قنوات elahmad.ru/tv: نجلب رابط البث عبر الـ Worker أولًا (?r=e:…)، وإن تعذّر نعرض صفحة القناة الأصلية =====
    // أي قناة رابطها يبدأ بـ https://www.elahmad.ru/tv تمرّ تلقائيًا من هنا (لا حاجة لتعديل بطاقاتها).
    const ELAHMAD_PREFIX = 'https://www.elahmad.ru/tv';
    let elahmadFallbackPage = '';          // صفحة المصدر: تُعرض فقط إذا فشل تشغيل البث المستخرج
    function isElahmadPage(u) { return typeof u === 'string' && u.indexOf(ELAHMAD_PREFIX + '/') === 0; }
    
async function playElahmad(title, pageUrl) {
  fillTheaterRail(title);
  // MBC Action يستخدم DASH ويُرفض طلب MPD من Cloudflare أحيانًا؛
  // اعرض صفحة المصدر الأصلية داخل نافذة PITA TV أولًا، مع زر احتياطي لفتحها في تبويب جديد.
  if (/\bid=mbc_action(?:&|$)/i.test(pageUrl)) {
    elahmadFallbackPage = '';
    playEngine(title, pageUrl, 'iframe');
    return;
  }

  const seq = ++playSeq;
  const modal = document.getElementById('videoModal');
  const spinner = document.getElementById('loadingSpinner');

  document.getElementById('modalTitle').textContent = title;
  destroyTsPlayer();
  clearPlayerMsg();
  try { if (window.jwplayer && window.jwplayer('playerElement').remove) window.jwplayer('playerElement').remove(); } catch (e) {}
  const __pc = document.getElementById('playerContainer');
  if (__pc) __pc.classList.remove('matches-mode');
  const __oldIf = __pc && __pc.querySelector('iframe');
  if (__oldIf) __oldIf.remove();
  if (!document.getElementById('playerElement')) {
    const d = document.createElement('div'); d.id = 'playerElement'; __pc.appendChild(d);
  }

  spinner.style.display = 'block';
  modal.style.display = 'flex';
  showPlayerMsg('جاري استخراج رابط البث…');

  const rid = 'e:' + pageUrl.slice(ELAHMAD_PREFIX.length + 1);
  let streamUrl = '';
  let ok = false;

  try {
    // استخراج رابط HLS الأصلي من Worker
    const extractUrl = PROXY_BASE
      + '?r=' + encodeURIComponent(rid)
      + '&extract=1';

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);

    const response = await fetch(extractUrl, {
      signal: ctl.signal,
      cache: 'no-store'
    });

    clearTimeout(timer);

    if (response.ok) {
      const data = await response.json();

      if (data && data.ok && data.url) {
        // تمرير رابط البث المستخرج عبر البروكسي
        streamUrl = PROXY_BASE
          + '?u=' + encodeURIComponent(data.url)
          + '&type=hls';

        const checkCtl = new AbortController();
        const checkTimer = setTimeout(() => checkCtl.abort(), 15000);

        const check = await fetch(streamUrl, {
          signal: checkCtl.signal,
          cache: 'no-store'
        });

        const body = check.ok ? await check.text() : '';
        clearTimeout(checkTimer);

        ok = check.ok && /^\s*#EXTM3U/.test(body);
      }
    }
  } catch (e) {
    console.error('Elahmad extraction error:', e);
    ok = false;
  }

  if (seq !== playSeq || modal.style.display === 'none') return;

  if (ok) {
    elahmadFallbackPage = pageUrl;
    playEngine(title, streamUrl, 'hls');
  } else {
    console.error('تعذر استخراج أو تحميل قائمة HLS');
    playEngine(title, pageUrl, 'iframe');
  }
}
    // =====================================================================
    // نظام تعدد السيرفرات + التحويل التلقائي (Auto Failover)
    // ---------------------------------------------------------------------
    // الفكرة: بطاقات القنوات القديمة لا تتغيّر إطلاقاً (playChannel('الاسم', 'الرابط', 'النوع') كما هي).
    // لإضافة سيرفرات بديلة لقناة، أضف سطراً في CHANNEL_SERVERS مفتاحه اسم القناة تماماً كما كُتب
    // في أول وسيط لـ playChannel. رابط البطاقة نفسه يبقى «Server 1» تلقائياً، وما تضيفه يأتي بعده.
    //
    //   const CHANNEL_SERVERS = {
    //     'Bein1': [
    //       { name: 'Server 2', url: 'https://example.com/bein1-b.m3u8', type: 'hls' },
    //       { name: 'Server 3', url: 'https://example.com/embed/bein1',  type: 'iframe' }
    //     ]
    //   };
    //
    // أنواع type المسموحة: 'hls' | 'ts' | 'tsaac' | 'iframe' | 'auto' (أو احذفه ليُكتشف النوع تلقائياً كما في النظام القديم).
    // روابط http:// و ch: و elahmad تمرّ كما هي عبر نفس آليات الـ Proxy/الـ Worker الحالية (autoProxy).
    // طريقة بديلة (قائمة كاملة داخل البطاقة نفسها):
    //   onclick="playChannel('اسم', [{name:'Server 1',url:'...',type:'hls'},{name:'Server 2',url:'...'}])"
    // =====================================================================
    const CHANNEL_SERVERS = {
    };
    const SRV_START_TIMEOUT = 25000;    // أقصى انتظار لبدء تشغيل HLS/TS قبل اعتبار السيرفر فاشلاً (مللي ثانية)
    const SRV_IFRAME_TIMEOUT = 30000;   // أقصى انتظار لحدث تحميل الإطار الخارجي (iframe)
    const SRV_SWITCH_DELAY = 800;       // مهلة قصيرة تُعرض فيها رسالة «جارٍ التحويل…» قبل السيرفر التالي
    const SRV_MAX_SWITCH_CYCLES = 3;    // سقف التحويلات المتتالية دون استقرار = عدد السيرفرات × 3
    const SRV_STABLE_MS = 60000;        // بعد دقيقة تشغيل مستقر يُصفَّر عدّاد التحويلات
    let SRV = null;                     // جلسة القناة الحالية (null = لا قناة مفتوحة)
    let srvNoteTimer = null;

    function srvEl(id) { return document.getElementById(id); }

    function srvNormalize(list) {
      const out = [];
      (Array.isArray(list) ? list : []).forEach((s) => {
        if (typeof s === 'string') s = { url: s };
        if (!s || typeof s.url !== 'string' || !s.url.trim()) return;
        const t = String(s.type || '').toLowerCase();
        out.push({ name: (s.name && String(s.name).trim()) || '', url: s.url.trim(), type: (t && t !== 'auto') ? t : undefined });
      });
      return out;
    }

    // يبني قائمة السيرفرات: (أ) مصفوفة/كائن servers مباشرة، أو (ب) رابط البطاقة = Server 1 + ما في CHANNEL_SERVERS
    function srvBuild(title, url, type) {
      let list;
      if (Array.isArray(url)) list = srvNormalize(url);
      else if (url && typeof url === 'object' && Array.isArray(url.servers)) list = srvNormalize(url.servers);
      else {
        list = [{ name: '', url: url, type: type }];                 // المسار القديم: يُمرَّر كما هو دون أي تعديل
        const extra = Object.prototype.hasOwnProperty.call(CHANNEL_SERVERS, title) ? CHANNEL_SERVERS[title] : null;
        srvNormalize(Array.isArray(extra) ? extra : (extra && extra.servers)).forEach((s) => {
          if (s.url === String(url).trim()) { if (s.name) list[0].name = s.name; return; }   // نفس رابط البطاقة: لا نكرره
          list.push(s);
        });
      }
      list.forEach((s, i) => { if (!s.name) s.name = 'Server ' + (i + 1); });
      return list;
    }

    // نوع السيرفر لأغراض العرض فقط (لا يؤثر على منطق التشغيل)
    function srvKind(s) {
      const u = String(s.url);
      if (s.type === 'iframe') return 'iframe';
      if (s.type === 'hls' || /m3u8/i.test(u) || /^ch:/i.test(u)) return 'hls';
      if (s.type === 'ts' || s.type === 'tsaac' || /\.ts(\?|#|$)/i.test(u)) return 'ts';
      return 'iframe';
    }
    function srvKindLabel(k) { return k === 'hls' ? 'HLS' : (k === 'ts' ? 'TS' : 'إطار'); }

    // ---------- الواجهة ----------
    function srvNote(text, kind) {
      const n = srvEl('srvNote'); if (!n) return;
      clearTimeout(srvNoteTimer);
      if (!text) { n.style.display = 'none'; n.textContent = ''; return; }
      n.textContent = text; n.className = 'srv-note ' + (kind || ''); n.style.display = 'block';
    }
    function srvTriedCount(S) { let c = 0; for (let i = 0; i < S.servers.length; i++) if (S.tried[i]) c++; return c; }

    function srvUi() {
      const btn = srvEl('serversBtn'), panel = srvEl('serversPanel');
      if (!btn || !panel) return;
      const S = SRV;
      if (!S || S.servers.length < 2) {                      // قناة بسيرفر واحد: لا واجهة إضافية إطلاقاً
        btn.style.display = 'none'; panel.classList.remove('open'); panel.textContent = '';
        btn.setAttribute('aria-expanded', 'false'); return;
      }
      btn.style.display = 'inline-flex';
      btn.querySelector('.cnt').textContent = (S.idx + 1) + '/' + S.servers.length;
      btn.setAttribute('aria-expanded', S.panelOpen ? 'true' : 'false');
      panel.classList.toggle('open', !!S.panelOpen);
      panel.textContent = '';

      const head = document.createElement('div'); head.className = 'srv-head';
      const ttl = document.createElement('strong'); ttl.textContent = 'السيرفرات المتاحة (' + S.servers.length + ')';
      const auto = document.createElement('button');
      auto.type = 'button'; auto.className = 'srv-auto' + (S.auto ? ' on' : '');
      auto.setAttribute('role', 'switch'); auto.setAttribute('aria-checked', S.auto ? 'true' : 'false');
      auto.textContent = S.auto ? 'تحويل تلقائي: مفعّل' : 'تحويل تلقائي: متوقف';
      head.appendChild(ttl); head.appendChild(auto); panel.appendChild(head);

      let hasFrame = false;
      S.servers.forEach((s, i) => {
        const att = S.attempt, active = i === S.idx;
        const failed = active ? !!(att && att.failed) : !!S.failed[i];
        const loading = active && att && !att.failed && !att.playing;
        const kind = srvKind(s); if (kind === 'iframe') hasFrame = true;
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'srv-item' + (active ? ' active' : '') + (failed ? ' failed' : '') + (loading ? ' loading' : '');
        b.dataset.i = String(i);
        if (active) b.setAttribute('aria-current', 'true');
        const dot = document.createElement('span'); dot.className = 'srv-dot';
        const nm = document.createElement('span'); nm.className = 'srv-name'; nm.textContent = s.name;
        const meta = document.createElement('span'); meta.className = 'srv-meta';
        const tag = document.createElement('span'); tag.className = 'srv-tag'; tag.textContent = srvKindLabel(kind);
        const st = document.createElement('span');
        if (failed) st.textContent = 'فشل';
        else if (loading) st.textContent = 'جارٍ التحميل…';
        else if (active) st.textContent = (kind === 'iframe' ? 'محمّل' : 'يعمل') + ' · ' + (S.by[i] === 'manual' ? 'اختيار يدوي' : 'اختيار تلقائي');
        if (failed && active) st.textContent += ' · ' + (S.by[i] === 'manual' ? 'يدوي' : 'تلقائي');
        meta.appendChild(tag); if (st.textContent) meta.appendChild(st);
        b.appendChild(dot); b.appendChild(nm); b.appendChild(meta);
        panel.appendChild(b);
      });
      if (S.allFailed) {
        const r = document.createElement('button'); r.type = 'button'; r.className = 'srv-retry';
        r.textContent = 'إعادة المحاولة من أول سيرفر'; panel.appendChild(r);
      }
      if (hasFrame) {
        const f = document.createElement('div'); f.className = 'srv-foot';
        f.textContent = 'ملاحظة: فشل روابط «إطار» الخارجية لا يمكن اكتشافه تلقائياً بسبب قيود المتصفح؛ التحويل لها يتم فقط عند تعذّر تحميل الإطار.';
        panel.appendChild(f);
      }
    }
    function srvPanel(open) { if (SRV) { SRV.panelOpen = open; srvUi(); } }

    // ---------- دورة حياة الجلسة ----------
    function srvReset() {
      const S = SRV;
      if (S) { clearTimeout(S.timer); if (S.attempt) { S.attempt.dead = true; clearTimeout(S.attempt.wd); } }
      SRV = null; srvNote(''); srvUi();
    }
    function srvStale(att) { return !!att && (att.dead || !SRV || SRV.attempt !== att); }

    function srvStart(idx, by) {
      const S = SRV; if (!S) return;
      clearTimeout(S.timer); S.timer = null;
      if (S.attempt) { S.attempt.dead = true; clearTimeout(S.attempt.wd); }   // أي مؤقت/حدث متأخر من المحاولة السابقة يُهمَل
      S.idx = idx; S.by[idx] = by; S.tried[idx] = true; S.failed[idx] = false; S.allFailed = false;
      const att = { S: S, idx: idx, dead: false, failed: false, playing: false, wd: null, okAt: 0 };
      S.attempt = att;
      srvUi();
      const s = S.servers[idx];
      playEngine(S.title, s.url, s.type);   // المحرّك القديم نفسه: يُنظّف المشغّل السابق ثم يُهيّئ المصدر الجديد
    }

    // مؤقت «لم يبدأ التشغيل»: يُفعَّل فقط للقنوات متعددة السيرفرات
    function srvArm(att, ms, probe) {
      if (!att || !SRV || SRV.servers.length < 2) return;
      clearTimeout(att.wd);
      att.wd = setTimeout(() => {
        if (att.dead || att.playing || att.failed) return;
        try { if (probe && probe()) return; } catch (e) { }
        srvFail(att, 'timeout', 'لم يبدأ التشغيل خلال ' + Math.round(ms / 1000) + ' ثانية');
      }, ms);
    }
    function srvDisarm(att) { if (att) clearTimeout(att.wd); }

    function srvOk(att) {
      const S = SRV;
      if (!att || !S || att.dead || S.attempt !== att) return;
      clearTimeout(att.wd);
      if (att.playing) return;
      if (att.failed && S.timer) { clearTimeout(S.timer); S.timer = null; att.failed = false; }   // نجح متأخراً قبل التحويل: نلغي التحويل
      att.playing = true; att.okAt = Date.now();
      S.tried = []; S.tried[S.idx] = true; S.failed = []; S.allFailed = false;                       // نجاح = بداية دورة جديدة
      if (S.noteShown) {
        S.noteShown = false;
        srvNote('يعمل الآن: ' + S.servers[S.idx].name, 'ok');
        srvNoteTimer = setTimeout(() => srvNote(''), 2500);
      }
      srvUi();
    }

    // يُعيد true إذا تولّى النظام الأمر (تحويل/رسالة)، وfalse ليكمل المحرّك سلوكه القديم (قناة بسيرفر واحد)
    function srvFail(att, reason, detail) {
      if (!att) return false;
      if (srvStale(att)) return true;                      // محاولة قديمة: تجاهل كامل
      const S = SRV;
      if (S.servers.length < 2) return false;
      if (att.failed) {                                    // فشل واحد فقط لكل محاولة (التقارير المكررة تُهمَل)
        const sp = srvEl('loadingSpinner'); if (sp && S.timer) sp.style.display = 'block';   // المحرّك القديم يخفي المؤشر عند كل خطأ
        return true;
      }
      att.failed = true; clearTimeout(att.wd);
      S.failed[att.idx] = true;
      console.warn('[PITA servers] فشل', S.servers[att.idx].name, '—', reason, detail || '');
      if (att.okAt && Date.now() - att.okAt > SRV_STABLE_MS) S.switches = 0;
      if (!S.auto) {                                       // اختيار يدوي: لا تحويل تلقائي
        const sp = srvEl('loadingSpinner'); if (sp) sp.style.display = 'none';
        srvNote('تعذّر تشغيل «' + S.servers[att.idx].name + '». اختر سيرفراً آخر من زر «السيرفرات» أو فعّل التحويل التلقائي.', 'err');
        S.noteShown = true; S.panelOpen = true; srvUi(); return true;
      }
      srvAdvance(att, detail);
      return true;
    }

    // يختار أول سيرفر لم يُجرَّب في الدورة الحالية؛ وإذا لم يبقَ أحد يعرض رسالة الفشل الشامل
    function srvAdvance(att, detail) {
      const S = att.S, n = S.servers.length, sp = srvEl('loadingSpinner');
      let next = -1;
      if (S.switches < n * SRV_MAX_SWITCH_CYCLES) {
        for (let k = 1; k < n; k++) { const j = (att.idx + k) % n; if (!S.tried[j]) { next = j; break; } }
      }
      if (next < 0) {
        S.allFailed = true; S.noteShown = true; S.panelOpen = true;
        if (sp) sp.style.display = 'none';
        srvNote('تعذّر تشغيل القناة على جميع السيرفرات (' + n + ').' + (detail ? ' آخر خطأ: ' + detail : '') + ' اختر سيرفراً يدوياً أو أعد المحاولة.', 'err');
        srvUi(); return;
      }
      S.switches++; S.noteShown = true;
      if (sp) sp.style.display = 'block';
      srvNote('تعذّر «' + S.servers[att.idx].name + '» — جارٍ التحويل إلى «' + S.servers[next].name + '» (' + (srvTriedCount(S) + 1) + '/' + n + ')…', 'load');
      S.timer = setTimeout(() => { S.timer = null; if (SRV === S && S.attempt === att) srvStart(next, 'auto'); }, SRV_SWITCH_DELAY);
      srvUi();
    }

    // اختيار يدوي: يوقف التحويل التلقائي ويعتبر السيرفر المختار هو المفضّل الحالي
    function srvPick(i) {
      const S = SRV; if (!S || i < 0 || i >= S.servers.length) return;
      const att = S.attempt;
      if (i === S.idx && att && !att.failed && !S.allFailed) { srvPanel(false); return; }   // هو النشط ويعمل
      S.auto = false; S.switches = 0; S.tried = []; S.panelOpen = false; S.noteShown = true;
      srvNote('جارٍ تشغيل «' + S.servers[i].name + '»…', 'load');
      srvStart(i, 'manual');
    }
    function srvSetAuto(on) {
      const S = SRV; if (!S) return;
      S.auto = on;
      const att = S.attempt;
      if (on && att && att.failed && !S.timer) {          // السيرفر الحالي فاشل: نبدأ دورة تحويل جديدة منه
        S.tried = []; S.tried[S.idx] = true; S.allFailed = false; S.switches = 0;
        srvAdvance(att, ''); return;
      }
      srvUi();
    }
    function srvRestart() {
      const S = SRV; if (!S) return;
      S.auto = true; S.tried = []; S.failed = []; S.allFailed = false; S.switches = 0; S.panelOpen = false; S.noteShown = true;
      srvNote('إعادة المحاولة من «' + S.servers[0].name + '»…', 'load');
      srvStart(0, 'auto');
    }

    // ---------- نقطة الدخول العامة: نفس توقيع playChannel القديم تماماً ----------
    function playChannel(title, url, type) {
      try { srvPlay(title, url, type); }
      catch (e) {                                           // أي عطل في طبقة السيرفرات ⇒ نرجع للمشغّل القديم مباشرة
        console.error('[PITA servers] fallback to legacy player', e);
        SRV = null;
        if (Array.isArray(url) && url[0]) { type = url[0].type; url = url[0].url; }
        playEngine(title, url, type);
      }
    }
    function srvPlay(title, url, type) {
      srvReset();                                           // يلغي أي جلسة/مؤقت/تحويل للقناة السابقة
      const servers = srvBuild(title, url, type);
      if (!servers.length) { frenchNotice(title, 'لا يوجد رابط بث مُعدّ لهذه القناة.'); return; }
      SRV = { title: title, servers: servers, idx: 0, auto: true, tried: [], failed: [], by: [], switches: 0,
              attempt: null, timer: null, allFailed: false, panelOpen: false, noteShown: false };
      srvStart(0, 'auto');                                  // يبدأ بالسيرفر الأول (الأساسي)
    }

    // شارة عدد السيرفرات على البطاقات + ربط أحداث الواجهة (تُستدعى مرة واحدة عند التهيئة)
    function srvInit() {
      document.querySelectorAll('.channel-card').forEach((card) => {
        if (card.querySelector('.srv-count')) return;
        const oc = card.getAttribute('onclick') || '';
        const m = oc.match(/^\s*(?:playChannel|playFrench)\(\s*'((?:[^'\\]|\\.)*)'\s*(?:,\s*'((?:[^'\\]|\\.)*)')?/);
        if (!m) return;
        const title = m[1].replace(/\\'/g, "'");
        let n = 1;
        if (m[2] !== undefined) n = srvBuild(title, m[2].replace(/\\'/g, "'"), undefined).length;
        else n = (oc.match(/url\s*:/g) || []).length;
        if (n < 2) return;
        const b = document.createElement('span');
        b.className = 'srv-count'; b.title = n + ' سيرفرات'; b.innerHTML = n + ' <i class="fas fa-server"></i>';
        card.appendChild(b);
      });
      const btn = srvEl('serversBtn'), panel = srvEl('serversPanel');
      if (!btn || !panel) return;
      btn.addEventListener('click', (e) => { e.stopPropagation(); if (SRV) srvPanel(!SRV.panelOpen); });
      panel.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = e.target.closest ? e.target : null; if (!t) return;
        const it = t.closest('.srv-item'); if (it) { srvPick(parseInt(it.dataset.i, 10)); return; }
        if (t.closest('.srv-auto')) { if (SRV) srvSetAuto(!SRV.auto); return; }
        if (t.closest('.srv-retry')) srvRestart();
      });
      document.addEventListener('click', () => { if (SRV && SRV.panelOpen) srvPanel(false); });
      document.addEventListener('keydown', (e) => {         // Esc يغلق قائمة السيرفرات أولاً قبل إغلاق النافذة
        if (e.key === 'Escape' && SRV && SRV.panelOpen) { e.stopImmediatePropagation(); srvPanel(false); }
      });
    }

    // حماية: أي استثناء داخل دوال النظام الجديد لا يجوز أن يوقف المحرّك القديم (يُسجَّل في الـ console فقط)
    [['srvArm', undefined], ['srvDisarm', undefined], ['srvOk', undefined], ['srvFail', false], ['srvStale', false], ['srvUi', undefined], ['srvNote', undefined]].forEach(function (p) {
      const f = window[p[0]];
      window[p[0]] = function () { try { return f.apply(this, arguments); } catch (e) { console.error('[PITA servers]', p[0], e); return p[1]; } };
    });
    const srvInitRaw = srvInit;
    srvInit = function () { try { srvInitRaw(); } catch (e) { console.error('[PITA servers] init', e); } };

    // الوسيط الثالث اختياري: 'hls' لقناة رابطها بدون .m3u8 في آخره
    let playSeq = 0;   // يميّز جلسة التشغيل الحالية (لإلغاء إعادة المحاولة إذا غيّر المستخدم القناة)

    function fillTheaterRail(title) {
      const list = document.getElementById('theaterRailList');
      if (!list) return;
      list.innerHTML = '';
      const meta = (window.__PITA_META && window.__PITA_META.byTitle[title]) || null;
      const group = (meta && meta.groups && meta.groups[0]) || 'sports';
      const peers = (window.__PITA_META && window.__PITA_META.list || []).filter(function (c) {
        return c.groups.indexOf(group) > -1;
      }).slice(0, 24);
      peers.forEach(function (c) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'theater-item' + (c.title === title ? ' active' : '');
        btn.innerHTML = '<div class="channel-avatar" style="--accent:var(--g-' + group + ',var(--green))">' +
          (c.logo ? '<img src="' + c.logo + '" alt="">' : (c.icon ? '<i class="fas fa-' + c.icon + ' fa-icon"></i>' : String(c.name).slice(0, 2))) +
          '</div><span class="nm"></span>';
        btn.querySelector('.nm').textContent = c.name;
        btn.onclick = function () {
          try { var fn = new Function(c.onclick); fn(); } catch (e) { console.error(e); }
        };
        list.appendChild(btn);
      });
      if (!peers.length) {
        list.innerHTML = '<div class="srv-foot" style="padding:8px">لا قنوات مقترحة لهذا القسم.</div>';
      }
    }

    function setTheaterRail(open) {
      const rail = document.getElementById('theaterRail');
      const toggle = document.getElementById('theaterRailToggle');
      if (!rail) return;
      rail.classList.toggle('is-open', !!open);
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    (function setupTheaterRailUX() {
      const rail = document.getElementById('theaterRail');
      const hot = document.getElementById('theaterHotzone');
      const toggle = document.getElementById('theaterRailToggle');
      const closeBtn = document.getElementById('theaterRailClose');
      if (!rail) return;
      let hideTimer = null;
      function open() { clearTimeout(hideTimer); setTheaterRail(true); }
      function scheduleClose() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { setTheaterRail(false); }, 280);
      }
      if (hot) {
        hot.addEventListener('mouseenter', open);
        hot.addEventListener('mouseleave', scheduleClose);
      }
      rail.addEventListener('mouseenter', open);
      rail.addEventListener('mouseleave', scheduleClose);
      if (toggle) toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        setTheaterRail(!rail.classList.contains('is-open'));
      });
      if (closeBtn) closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        setTheaterRail(false);
      });
    })();

    function playEngine(title, url, type, _fallbackDone, _useAlt, _retry) {
      if (!type && isElahmadPage(url)) { playElahmad(title, url); return; }
      const fbPage = elahmadFallbackPage; elahmadFallbackPage = '';    // صفحة المصدر لهذه المحاولة فقط (إن كان البث مستخرجًا من elahmad)
      const origUrl = url;
      const att = SRV ? SRV.attempt : null;   // محاولة السيرفر الحالية (نظام تعدد السيرفرات)
      const mySeq = ++playSeq;
      _retry = _retry || 0;
      const modal = document.getElementById('videoModal');
      const titleEl = document.getElementById('modalTitle');
      const container = document.getElementById('playerContainer');
      const spinner = document.getElementById('loadingSpinner');

      titleEl.textContent = title;
      container.classList.remove('matches-mode');
      fillTheaterRail(title);
      setTheaterRail(false);
      if (/^ch:/i.test(url) && !type) type = 'hls'; // قناة محمية بدون نوع = HLS
      // رابط يدل على HLS (…m3u8 في المسار أو في الاستعلام مثل extension=m3u8) يُعامل كـ HLS حتى لو كُتب له النوع 'ts'
      const looksHls = /m3u8/i.test(url);
      if (looksHls && (type === 'ts' || type === 'tsaac')) type = 'hls';
      const isTs = !looksHls && (type === 'ts' || type === 'tsaac' || /\.ts(\?|#|$)/i.test(url));
      destroyTsPlayer();
      clearPlayerMsg();
      url = autoProxy(url, type === 'hls' || type === 'ts' || type === 'tsaac', _useAlt, type === 'tsaac');

      // Clear previous content
      // If JWPlayer exists, remove it
      // (عند الانتقال من iframe إلى سيرفر آخر يكون #playerElement محذوفًا؛ JW قد يرمي خطأ هنا فيتوقف التبديل)
      try {
        if (window.jwplayer && window.jwplayer('playerElement')) {
          window.jwplayer('playerElement').remove();
        }
      } catch (e) { }

      // Remove any iframe or video elements manually if they exist (from previous non-JWPlayer loads)
      const oldIframe = container.querySelector('iframe');
      if (oldIframe) oldIframe.remove();
      container.querySelectorAll('.open-source-btn').forEach((b) => b.remove());

      // Ensure we have a clean div for JWPlayer
      let playerDiv = document.getElementById('playerElement');
      if (!playerDiv) {
        playerDiv = document.createElement('div');
        playerDiv.id = 'playerElement';
        container.appendChild(playerDiv);
      }

      spinner.style.display = 'block';

      if (isTs) {
        if (window.jwplayer && window.jwplayer('playerElement')) {
          window.jwplayer('playerElement').remove();
        }
        playerDiv.remove();
        const video = document.createElement('video');
        video.id = 'tsVideo';
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.addEventListener('playing', () => { spinner.style.display = 'none'; srvOk(att); });
        container.appendChild(video);
        srvArm(att, SRV_START_TIMEOUT);
        loadMpegts().then(() => {
          if (!video.isConnected) return; // أُغلقت النافذة قبل تحميل المكتبة
          if (!window.mpegts || !mpegts.isSupported()) throw new Error('mpegts unsupported');
          tsPlayer = mpegts.createPlayer(
            { type: 'mpegts', isLive: true, url: url },
            {
              enableWorker: true,
              enableStashBuffer: false,              // زمن تأخير أقل وتعافٍ أسرع في البث المباشر
              liveBufferLatencyChasing: true,
              liveBufferLatencyMaxLatency: 6,
              liveBufferLatencyMinRemain: 1,
              autoCleanupSourceBuffer: true,         // يمنع امتلاء مخزن MSE (سبب شائع لخطأ MediaMSEError)
              autoCleanupMaxBackwardDuration: 30,
              autoCleanupMinBackwardDuration: 15
            }
          );
          tsPlayer.attachMediaElement(video);
          let tsInfo = null;
          tsPlayer.on(mpegts.Events.MEDIA_INFO, (mi) => { tsInfo = mi; });
          tsPlayer.on(mpegts.Events.ERROR, (t, d, info) => {
            console.error('mpegts error', t, d, info);
            spinner.style.display = 'none';
            // أخطاء الترميز/الانقطاع المؤقت: نعيد التشغيل تلقائيًا حتى 3 مرات. أما رفض السيرفر (HTTP) فنشخّصه مباشرة.
            // صوت غير مدعوم في المتصفح (MP2 مثلًا) يظهر كـ MediaMSEError: نحوّله على الخادم إن كان متاحًا
            if (d === 'MediaMSEError' && type !== 'tsaac' && ALT_SUPPORTS_AAC) {
              showPlayerMsg('الصوت غير مدعوم في المتصفح — أحوّله إلى AAC على الخادم…');
              playEngine(title, origUrl, 'tsaac', _fallbackDone, _useAlt);
              return;
            }
            if (d !== 'HttpStatusCodeInvalid' && _retry < 3) {
              showPlayerMsg('انقطع البث (' + (d || t) + ') — إعادة المحاولة ' + (_retry + 1) + '/3…');
              setTimeout(() => {
                if (mySeq === playSeq && document.getElementById('tsVideo')) playEngine(title, origUrl, type, _fallbackDone, _useAlt, _retry + 1);
              }, 1200);
              return;
            }
            diagnoseTsFailure(title, origUrl, url, t, d, info, tsInfo, _fallbackDone, _useAlt, type, att);
          });
          tsPlayer.load();
          const pr = tsPlayer.play();
          if (pr && pr.catch) pr.catch((err) => { if (err && err.name === 'NotAllowedError') srvDisarm(att); });   // المتصفح منع التشغيل التلقائي: ننتظر المستخدم بدل التحويل
        }).catch((e) => {
          console.error('TS player failed', e);
          if (srvFail(att, 'mpegts-load', 'تعذّر تحميل مشغّل TS')) return;
          spinner.style.display = 'none';
        });
      } else if (type === 'hls' || url.includes('.m3u8')) {
        // Initialize JWPlayer
        jwplayer("playerElement").setup({
          file: url,
          ...(type === 'hls' ? { type: 'hls' } : {}),
          width: "100%",
          height: "100%",
          autostart: true,
          stretching: "uniform",
          aspectratio: "16:9",
          primary: "html5",
          hlshtml: true,
          preload: "auto",
          skin: {
            name: "netflix"
          },
          events: {
            onReady: function () {
              spinner.style.display = 'none';
            },
            onPlay: function () {
              spinner.style.display = 'none';
              srvOk(att);
            },
            onAutostartNotAllowed: function () { srvDisarm(att); },   // التشغيل التلقائي ممنوع: ننتظر ضغط المستخدم
            onSetupError: function (e) {
              if (fbPage && mySeq === playSeq) { playEngine(title, fbPage, 'iframe'); return; }
              srvFail(att, 'jw-setup', (e && e.message) || '');
            },
            onError: function (e) {
              console.error('JWPlayer Error:', e);
              spinner.style.display = 'none';
              // بث elahmad المستخرج لم يعمل ⇒ الحل الثانوي: صفحة القناة الأصلية
              if (fbPage && mySeq === playSeq) { playEngine(title, fbPage, 'iframe'); return; }
              if (srvFail(att, 'jw-error', (e && e.message) || '')) return;   // سيرفر آخر متاح ⇒ تحويل تلقائي، وإلا السلوك القديم
              showPlayerMsg('⚠ تعذّر تشغيل HLS: ' + ((e && e.message) || 'خطأ غير معروف') + ' — جرّب صفحة test.html لمعرفة السبب.');
            }
          }
        });
        srvArm(att, SRV_START_TIMEOUT, function () { try { return jwplayer('playerElement').getState() === 'paused'; } catch (e) { return false; } });
      } else {
        // Iframe fallback
        // Remove player div temporarily to avoid conflicts or just hide it
        if (window.jwplayer && window.jwplayer('playerElement')) {
          window.jwplayer('playerElement').remove();
        }
        playerDiv.remove(); // Remove the div so iframe takes space

        const iframe = document.createElement('iframe');
        // منع نوافذ alert/confirm/prompt الصادرة من صفحات elahmad المضمّنة،
        // مع السماح للصفحة بتشغيل JavaScript وإرسال النماذج واستخدام ملفات الارتباط.
        // لا نضيف allow-modals عمدًا حتى لا تظهر نافذة "error" المنبثقة.
        if (isElahmadPage(url)) {
          iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation');
        }
        iframe.src = url;
        iframe.allow = 'autoplay; fullscreen; picture-in-picture';
        iframe.allowFullscreen = true;
        // مطابقة إعدادات الموقع المرجعي لمضيف syria-player (بقية الـ iframes لا تتأثر)
        if (/^https?:\/\/([^\/]+\.)?syria-player\.info\//i.test(url)) {
          iframe.referrerPolicy = 'no-referrer';
          iframe.allow = 'autoplay; encrypted-media; fullscreen; screen-wake-lock';
          // تمت إزالة sandbox هنا: صفحة syria-player ترفض العمل داخل iframe مقيّد
        }
        iframe.onload = () => { spinner.style.display = 'none'; srvOk(att); };
        container.appendChild(iframe);
        srvArm(att, SRV_IFRAME_TIMEOUT);   // لا يمكن مراقبة محتوى الإطار الخارجي؛ نراقب فقط تأخر حدث التحميل
        // بعض الصفحات ترفض العمل داخل إطار (خطأ 403 داخل المشغّل): زر يفتحها في نافذة مستقلة حيث تعمل
        if (isElahmadPage(url)) {
          const a = document.createElement('a');
          a.className = 'open-source-btn';
          a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.textContent = 'إذا لم يعمل البث داخل PITA TV، افتح القناة في تبويب جديد ↗';
          a.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:10px;z-index:9;padding:7px 14px;' +
            'border-radius:20px;background:rgba(0,0,0,.78);border:1px solid rgba(255,255,255,.3);color:#fff;' +
            'font:600 .8rem/1.4 sans-serif;text-decoration:none;white-space:nowrap';
          container.appendChild(a);
        }
      }

      modal.style.display = 'flex';
    }

    function closeModal() {
      srvReset();   // إيقاف مؤقتات/محاولات التحويل المرتبطة بالقناة
      const modal = document.getElementById('videoModal');
      const container = document.getElementById('playerContainer');
      const spinner = document.getElementById('loadingSpinner');

      // Hide spinner first
      if (spinner) {
        spinner.style.display = 'none';
      }

      destroyTsPlayer();
      clearPlayerMsg();
      if (container) container.classList.remove('matches-mode');

      // Stop and remove JWPlayer properly
      try {
        if (window.jwplayer && window.jwplayer('playerElement')) {
          const player = window.jwplayer('playerElement');
          player.stop();
          player.remove();
        }
      } catch (e) {
        console.log('Player cleanup error:', e);
      }

      container.querySelectorAll('.open-source-btn').forEach((b) => b.remove());
      // Remove iframe if exists
      const iframe = container.querySelector('iframe');
      if (iframe) {
        iframe.src = 'about:blank';
        iframe.remove();
      }
      const railList = document.getElementById('theaterRailList');
      if (railList) railList.innerHTML = '';
      setTheaterRail(false);
      setMatchesExpanded(false);


      // Clean up only the player div, not the entire container
      const oldPlayerDiv = document.getElementById('playerElement');
      if (oldPlayerDiv) {
        oldPlayerDiv.remove();
      }

      // Re-add fresh player div
      const playerDiv = document.createElement('div');
      playerDiv.id = 'playerElement';
      container.appendChild(playerDiv);

      // Hide modal
      modal.style.display = 'none';
    }

    // Close modal on outside click
    document.getElementById('videoModal').addEventListener('click', function (e) {
      if (e.target === this) {
        closeModal();
      }
    });

    // Initialize
    filterCategory('home');
    filterSub('algerian');
    srvInit();

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .then((registration) => {
            console.log('Service Worker registered successfully:', registration.scope);
          })
          .catch((error) => {
            console.log('Service Worker registration failed:', error);
          });
      });
    }

/* ===== تحسينات الواجهة (لا تغيّر منطق التشغيل الأصلي) ===== */
(function () {
  "use strict";
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* عدّاد القنوات في عنوان كل قسم */
  function addCounts() {
    $$(".category-section").forEach(function (sec) {
      var h = $(".section-header", sec); if (!h || $(".count", h) || sec.id === "general") return;
      var n = $$(".channel-card", sec).length;
      if (n) { var c = document.createElement("span"); c.className = "count"; c.textContent = n + " قناة"; h.appendChild(c); }
    });
  }

  /* عدد القنوات بجانب كل تصنيف فرعي في القنوات العامة */
  function addSubCounts() {
    var grid = $("#general-grid"); if (!grid) return;
    $$(".sub-btn").forEach(function (b) {
      var m = (b.getAttribute("onclick") || "").match(/'([^']+)'/); if (!m || $("small", b)) return;
      var n = $$(".channel-card." + m[1], grid).length;
      if (n) { var s = document.createElement("small"); s.textContent = n; b.appendChild(s); }
    });
  }

  /* ضوء يتبع المؤشر على البطاقات */
  document.addEventListener("pointermove", function (e) {
    var card = e.target.closest && e.target.closest(".channel-card"); if (!card) return;
    var r = card.getBoundingClientRect();
    card.style.setProperty("--mx", (e.clientX - r.left) + "px");
    card.style.setProperty("--my", (e.clientY - r.top) + "px");
  }, { passive: true });

  /* ===== المفضلة ===== */
  var favs = LS.get("pita_favs", []);
  function keyOf(card) { return card.getAttribute("onclick") || ""; }
  function addHearts(root) {
    $$(".channel-card", root).forEach(function (card) {
      if ($(".fav-btn", card)) return;
      var b = document.createElement("button");
      b.type = "button"; b.className = "fav-btn"; b.setAttribute("aria-label", "إضافة إلى المفضلة");
      b.innerHTML = '<i class="fas fa-heart"></i>';
      card.appendChild(b);
    });
  }
  function syncHearts() {
    $$(".channel-card").forEach(function (card) {
      var b = $(".fav-btn", card); if (!b) return;
      var on = favs.indexOf(keyOf(card)) > -1;
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
    });
  }
  function buildFavs() {
    var grid = $("#favs-grid"); if (!grid) return;
    grid.innerHTML = "";
    var seen = {};
    $$(".category-section:not(#favs) .channel-card").forEach(function (card) {
      var k = keyOf(card);
      if (favs.indexOf(k) > -1 && !seen[k]) { seen[k] = 1; var c = card.cloneNode(true); c.style.display = ""; c.className = "channel-card"; grid.appendChild(c); }
    });
    $("#favs-empty").style.display = grid.children.length ? "none" : "block";
    var cnt = $("#favs .count"); if (cnt) cnt.textContent = grid.children.length + " قناة";
    syncHearts();
  }
  function setupFavsSection() {
    var last = $$(".category-section").pop(); if (!last || $("#favs")) return;
    var sec = document.createElement("div");
    sec.id = "favs"; sec.className = "category-section";
    sec.innerHTML = '<div class="section-header"><h2>المفضلة</h2><span class="count"></span></div>' +
      '<div class="empty" id="favs-empty"><i class="fas fa-heart"></i>لم تضف قنوات بعد. اضغط على القلب في أي قناة لتظهر هنا.</div>' +
      '<div class="channels-grid" id="favs-grid"></div>';
    last.parentNode.insertBefore(sec, last.nextSibling);
    var nav = $(".nav-scroller");
    var btn = document.createElement("button");
    btn.className = "nav-btn"; btn.setAttribute("onclick", "filterCategory('favs')");
    btn.innerHTML = '<i class="fas fa-heart" style="margin-inline-end:6px"></i>المفضلة';
    nav.appendChild(btn);
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".fav-btn"); if (!b) return;
    e.stopPropagation(); e.preventDefault();
    var k = keyOf(b.closest(".channel-card")), i = favs.indexOf(k);
    if (i > -1) favs.splice(i, 1); else favs.push(k);
    LS.set("pita_favs", favs); buildFavs();
  }, true);

  /* ===== تابع المشاهدة + بطل الرئيسية ===== */
  var last = LS.get("pita_last", null);
  function renderHero() {
    var titleEl = $("#heroTitle"), subEl = $("#heroSub"), playBtn = $("#heroPlay");
    if (!titleEl || !playBtn) return;
    if (last && last.t) {
      titleEl.textContent = last.t;
      if (subEl) subEl.textContent = "تابع من حيث توقفت — اضغط تشغيل الآن لفتح آخر قناة شاهدتها.";
      playBtn.onclick = function () { window.playChannel(last.t, last.u, last.y || undefined); };
    } else {
      var first = (window.__PITA_META && window.__PITA_META.list || []).find(function (c) { return c.groups.indexOf("algerian") > -1; })
        || (window.__PITA_META && window.__PITA_META.list[0]);
      titleEl.textContent = first ? first.name : "بث مباشر للقنوات العربية";
      if (subEl) subEl.textContent = "اختر قناتك المفضلة من الصفوف بالأسفل، أو ابدأ بالقنوات الجزائرية.";
      playBtn.onclick = function () {
        if (first) { try { new Function(first.onclick)(); } catch (e) { filterCategory("general"); } }
        else filterCategory("general");
      };
    }
  }
  function renderResume() {
    var bar = $("#resume");
    if (!last) { if (bar) bar.classList.remove("show"); renderHero(); return; }
    if (!bar) {
      bar = document.createElement("div"); bar.id = "resume"; bar.className = "resume";
      bar.innerHTML = '<small>تابع المشاهدة</small><strong></strong><button type="button" class="go">تشغيل</button><button type="button" class="x" aria-label="إخفاء"><i class="fas fa-times"></i></button>';
      var shell = $(".main-shell") || $(".nav-scroller");
      if (shell) shell.insertBefore(bar, shell.firstChild);
      $(".go", bar).onclick = function () { if (last) window.playChannel(last.t, last.u, last.y); };
      $(".x", bar).onclick = function () { last = null; LS.set("pita_last", null); renderResume(); };
    }
    $("strong", bar).textContent = last.t; bar.classList.add("show");
    renderHero();
  }
  var origPlay = window.playChannel;
  window.playChannel = function (title, url, type) {
    last = { t: title, u: url, y: type || "" }; LS.set("pita_last", last); renderResume();
    var r = origPlay.apply(this, arguments);
    try { if (!(history.state && history.state.pitaModal)) history.pushState({ pitaModal: 1 }, ""); } catch (e) {}
    return r;
  };

  /* ===== النافذة: زر الرجوع في أندرويد + Esc + منع تمرير الخلفية ===== */
  var origClose = window.closeModal;
  var modal = $("#videoModal");
  function isOpen() { return modal && modal.style.display === "flex"; }
  window.closeModal = function () {
    origClose();
    if (history.state && history.state.pitaModal) { try { history.back(); } catch (e) {} }
  };
  window.addEventListener("popstate", function () { if (isOpen()) origClose(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) window.closeModal();
    else if (e.key === "/" && !/input|textarea/i.test((e.target.tagName || ""))) { e.preventDefault(); $("#searchInput").focus(); }
  });

  new MutationObserver(function () { document.body.style.overflow = isOpen() ? "hidden" : ""; })
    .observe(modal, { attributes: true, attributeFilter: ["style"] });

  /* ===== تهيئة ===== */
  addCounts(); addSubCounts(); addHearts(document); setupFavsSection(); addHearts($("#favs")); buildFavs(); renderResume(); renderHero();
  var si = $("#searchInput");
  if (si) { si.setAttribute("enterkeyhint", "search"); si.addEventListener("input", function () { document.body.classList.toggle("searching", si.value.length > 0); }); }
})();
