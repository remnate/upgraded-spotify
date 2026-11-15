// NAME: Волна
// AUTHOR: remnate
// DESCRIPTION: Полноэкранный плеер поверх Spotify: обложка, волна, синхронный текст, очередь, мини-плеер поверх окон.
// Открыть: кнопка с волной в верхней панели / в плеер-баре или Ctrl+Shift+V. Шпаргалка по клавишам: H.

(function Volna() {
  const S = window.Spicetify;
  if (!S || !S.Player || !S.Player.addEventListener || !S.Topbar || !S.CosmosAsync || !document.body) {
    setTimeout(Volna, 300);
    return;
  }
  const ID = "volna-root";
  if (document.getElementById(ID)) return;

  // ================= settings =================
  const DEF = { view: "cover", pulse: true, liveBg: true, tilt: true, lrclib: true, remaining: false, idleOpen: 0, hints: 0, lyrOffset: 0, viz: true, vizStyle: "bars" };
  const cfg = { ...DEF };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem("volna:cfg") || "{}")); } catch (e) {}
  if (!["bars", "bass"].includes(cfg.vizStyle)) cfg.vizStyle = "bars";
  const save = () => { try { localStorage.setItem("volna:cfg", JSON.stringify(cfg)); } catch (e) {} };

  // ================= helpers =================
  const $ = (sel, root = document) => root.querySelector(sel);
  const fmt = (ms) => {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const imgUrl = (u) => (!u ? "" : u.startsWith("spotify:image:") ? "https://i.scdn.co/image/" + u.slice(14) : u);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const idOf = (uri) => (uri || "").split(":")[2] || "";
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function track() {
    const d = S.Player.data || {};
    return d.item || d.track || null;
  }

  function info() {
    const t = track();
    if (!t) return null;
    const m = t.metadata || {};
    let artists = (t.artists || []).map((a) => ({ name: a.name, uri: a.uri }));
    if (!artists.length) {
      for (const k of ["", ":1", ":2", ":3"]) if (m["artist_name" + k]) artists.push({ name: m["artist_name" + k], uri: m["artist_uri" + k] });
    }
    const img =
      m.image_xlarge_url || m.image_large_url || m.image_url ||
      (t.album && t.album.images && t.album.images.length && t.album.images[t.album.images.length - 1].url) || "";
    return {
      uri: t.uri,
      title: t.name || m.title || "—",
      artists,
      album: (t.album && t.album.name) || m.album_title || "",
      albumUri: (t.album && t.album.uri) || m.album_uri || "",
      image: imgUrl(img),
      duration: S.Player.getDuration() || (t.duration && t.duration.milliseconds) || +m.duration || 0,
    };
  }

  // ================= caches =================
  // In-memory LRU (most recent last) + on-disk IndexedDB so tracks you've heard open instantly after a restart.
  function lruSet(map, key, val, cap) {
    map.delete(key);
    map.set(key, val);
    while (map.size > cap) map.delete(map.keys().next().value);
    return val;
  }
  function lruGet(map, key) {
    if (!map.has(key)) return undefined;
    const v = map.get(key);
    map.delete(key);
    map.set(key, v);
    return v;
  }
  const DB = (() => {
    let ready = null;
    const open = () => ready || (ready = new Promise((res) => {
      try {
        const r = indexedDB.open("volna-cache", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("t", { keyPath: "k" }).createIndex("t", "t");
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    }));
    const req = (q) => new Promise((res) => { q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
    return {
      async get(k) {
        const db = await open();
        if (!db) return null;
        try { return (await req(db.transaction("t").objectStore("t").get(k))) || null; } catch (e) { return null; }
      },
      async put(k, v) {
        const db = await open();
        if (!db) return;
        try { db.transaction("t", "readwrite").objectStore("t").put({ k, t: Date.now(), v }); } catch (e) {}
      },
      async del(k) {
        const db = await open();
        if (!db) return;
        try { db.transaction("t", "readwrite").objectStore("t").delete(k); } catch (e) {}
      },
      async prune(max) {
        const db = await open();
        if (!db) return;
        try {
          const store = db.transaction("t", "readwrite").objectStore("t");
          let extra = (await req(store.count())) - max;
          if (extra <= 0) return;
          const cur = store.index("t").openCursor();
          cur.onsuccess = () => { const c = cur.result; if (c && extra-- > 0) { c.delete(); c.continue(); } };
        } catch (e) {}
      },
    };
  })();
  setTimeout(() => DB.prune(1500), 15000);

  // ================= audio analysis (waveform + beats) =================
  function seeded(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  }

  function fakePeaks(uri, n = 400) {
    const rnd = seeded(uri || "volna");
    const sections = [];
    for (let pos = 0; pos < 1; ) {
      const len = 0.08 + rnd() * 0.18;
      sections.push({ start: pos, end: pos + len, energy: 0.45 + rnd() * 0.55 });
      pos += len;
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / n;
      const sec = sections.find((s) => x >= s.start && x < s.end) || sections[sections.length - 1];
      let v = sec.energy * (0.55 + rnd() * 0.45);
      if (x < 0.03) v *= x / 0.03;
      if (x > 0.95) v *= (1 - x) / 0.05;
      out[i] = clamp(v, 0.06, 1);
    }
    return out;
  }

  function parseAudio(data, n = 400) {
    const segs = data && data.segments;
    const dur = data && data.track && data.track.duration;
    if (!segs || !segs.length || !dur) return null;
    // duration-weighted mean loudness (dB) per bin
    const sum = new Array(n).fill(0), wt = new Array(n).fill(0);
    for (const s of segs) {
      const a = Math.max(0, Math.floor((s.start / dur) * n));
      const b = Math.min(n, Math.max(a + 1, Math.ceil(((s.start + s.duration) / dur) * n)));
      for (let i = a; i < b; i++) { sum[i] += s.loudness_max * s.duration; wt[i] += s.duration; }
    }
    const db = sum.map((v, i) => (wt[i] ? v / wt[i] : -60));
    // normalise against this track's own range so loud masters don't look flat
    const sorted = [...db].sort((x, y) => x - y);
    const lo = sorted[Math.floor(sorted.length * 0.04)];
    const hi = sorted[Math.floor(sorted.length * 0.985)];
    const span = Math.max(3, hi - lo);
    const peaks = db.map((v) => 0.1 + 0.9 * Math.pow(clamp((v - lo) / span, 0, 1), 1.5));
    const beats = (data.beats || []).filter((b) => b && isFinite(b.start)).map((b) => ({ start: b.start, duration: b.duration || 0.5, confidence: b.confidence ?? 0.5 }));
    const onsets = segs.filter((g) => g.loudness_max - g.loudness_start > 5).map((g) => Math.round(g.start * 1000));
    const lms = segs.map((g) => g.loudness_max).sort((a, b) => a - b);
    const vlo = lms[Math.floor(lms.length * 0.1)] - 6, vhi = lms[Math.floor(lms.length * 0.98)];
    const vsegs = segs.map((g) => ({ s: g.start * 1000, d: g.duration * 1000, l0: g.loudness_start, lm: g.loudness_max, lt: (g.loudness_max_time || 0) * 1000, p: g.pitches, tb: g.timbre }));
    return { peaks, beats, onsets, segs: vsegs, vlo, vhi: Math.max(vhi, vlo + 6), real: true };
  }

  // segments packed into one Float32Array for the disk cache: s,d,l0,lm,lt,timbre1,pitch0..11
  const SEG = 18;
  function packSegs(segs) {
    const f = new Float32Array(segs.length * SEG);
    segs.forEach((g, i) => {
      const o = i * SEG;
      f.set([g.s, g.d, g.l0, g.lm, g.lt, (g.tb && g.tb[1]) || 0], o);
      if (g.p) f.set(g.p.slice(0, 12), o + 6);
    });
    return f;
  }
  function unpackSegs(f) {
    const out = [];
    for (let o = 0; o + SEG <= f.length; o += SEG)
      out.push({ s: f[o], d: f[o + 1], l0: f[o + 2], lm: f[o + 3], lt: f[o + 4], tb: [0, f[o + 5]], p: Array.from(f.subarray(o + 6, o + 18)) });
    return out;
  }
  const AUDIO = new Map(); // uri -> Promise<{peaks, beats, onsets, segs, real}>
  function analysis(uri) {
    const hit = lruGet(AUDIO, uri);
    if (hit) return hit;
    return lruSet(AUDIO, uri, (async () => {
      const disk = await DB.get("a:" + uri);
      if (disk && disk.v) { const v = disk.v; return { ...v, segs: v.segsPacked ? unpackSegs(v.segsPacked) : [], real: true }; }
      try {
        if (S.getAudioData) {
          const r = parseAudio(await withTimeout(S.getAudioData(uri), 6000));
          if (r) {
            DB.put("a:" + uri, { peaks: r.peaks, beats: r.beats, onsets: r.onsets, vlo: r.vlo, vhi: r.vhi, segsPacked: packSegs(r.segs) });
            return r;
          }
        }
      } catch (e) {}
      return { peaks: fakePeaks(uri), beats: [], onsets: [], real: false };
    })(), 40);
  }

  // ================= lyrics =================
  function parseLrc(text) {
    const out = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      if (!stamps.length) continue;
      const body = raw.replace(/\[[^\]]*\]/g, "").trim();
      let tokens = null;
      if (/<\d+:\d+(?:\.\d+)?>/.test(body)) {
        // enhanced LRC: <mm:ss.xx> word <mm:ss.xx> word ...
        tokens = [];
        const parts = body.split(/<(\d+):(\d+(?:\.\d+)?)>/);
        for (let k = 1; k < parts.length; k += 3) {
          const t = Math.round((+parts[k] * 60 + +parts[k + 1]) * 1000);
          for (const w of (parts[k + 2] || "").trim().split(/\s+/).filter(Boolean)) tokens.push({ text: w, t: tokens.length && tokens[tokens.length - 1].t === t ? null : t });
        }
      }
      const words = tokens ? tokens.map((x) => x.text).join(" ") : body;
      for (const m of stamps) out.push({ t: Math.round((+m[1] * 60 + +m[2]) * 1000), text: words, tokens: tokens || undefined });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  async function fromSpotify(i) {
    const r = await withTimeout(
      S.CosmosAsync.get(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${idOf(i.uri)}?format=json&vocalRemoval=false&market=from_token`),
      6000
    );
    const L = r && r.lyrics;
    if (!L || !L.lines || !L.lines.length) return null;
    const synced = L.syncType === "LINE_SYNCED";
    const lines = L.lines.map((l) => {
      const text = (l.words || "").trim();
      const line = { t: +l.startTimeMs || 0, text };
      if (Array.isArray(l.syllables) && l.syllables.length && l.syllables.every((x) => x && x.startTimeMs != null && x.numChars != null)) {
        let off = 0;
        const marks = l.syllables.map((x) => { const m = { off, t: +x.startTimeMs }; off += +x.numChars; return m; });
        const tokens = [];
        let pos = 0;
        for (const w of text.split(/\s+/).filter(Boolean)) {
          const at = text.indexOf(w, pos);
          pos = at + w.length;
          let t = null;
          for (const m of marks) if (m.off <= at) t = m.t;
          tokens.push({ text: w, t });
        }
        line.tokens = tokens;
      }
      return line;
    });
    return { synced, source: "Spotify", lines };
  }

  async function fromLrclib(i) {
    const q = new URLSearchParams({
      artist_name: (i.artists[0] && i.artists[0].name) || "",
      track_name: i.title,
      album_name: i.album,
      duration: String(Math.round(i.duration / 1000)),
    });
    let res = await withTimeout(fetch("https://lrclib.net/api/get?" + q), 7000);
    let d = res.ok ? await res.json() : null;
    if (!d) {
      const sq = new URLSearchParams({ track_name: i.title, artist_name: q.get("artist_name") });
      res = await withTimeout(fetch("https://lrclib.net/api/search?" + sq), 7000);
      const list = res.ok ? await res.json() : [];
      d = (list || []).find((x) => x.syncedLyrics && Math.abs((x.duration || 0) - i.duration / 1000) < 4) || (list || []).find((x) => x.plainLyrics);
    }
    if (!d) return null;
    if (d.syncedLyrics) {
      const lines = parseLrc(d.syncedLyrics);
      if (lines.length) return { synced: true, source: "LRCLIB", lines };
    }
    if (d.plainLyrics) return { synced: false, source: "LRCLIB", lines: d.plainLyrics.split(/\r?\n/).map((text) => ({ t: 0, text: text.trim() })) };
    return null;
  }

  const LYR = new Map(); // uri -> Promise<lyrics|null>
  function lyricsFor(i) {
    if (!i || !i.uri || !i.uri.startsWith("spotify:track:")) return Promise.resolve(null);
    const hit = lruGet(LYR, i.uri);
    if (hit) return hit;
    return lruSet(LYR, i.uri, (async () => {
      const disk = await DB.get("l:" + i.uri);
      if (disk) {
        if (disk.v) return disk.v;
        if (Date.now() - disk.t < 7 * 864e5) return null; // known: no lyrics (re-checked weekly)
      }
      let r = null;
      try { r = await fromSpotify(i); } catch (e) {}
      if (!r && cfg.lrclib) { try { r = await fromLrclib(i); } catch (e) {} }
      DB.put("l:" + i.uri, r);
      return r;
    })(), 120);
  }

  // ================= colours =================
  function rgbFromHex(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(hex || "");
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }
  function canvasColor(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = c.height = 32;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, 32, 32);
          const d = ctx.getImageData(0, 0, 32, 32).data;
          const buckets = new Map();
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const sat = max === 0 ? 0 : (max - min) / max;
            const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
            const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, w: 0 };
            e.r += r; e.g += g; e.b += b; e.n++;
            e.w += 1 + sat * 3 * (max > 40 ? 1 : 0.2);
            buckets.set(key, e);
          }
          let best = null;
          for (const e of buckets.values()) if (!best || e.w > best.w) best = e;
          resolve(best ? [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round) : null);
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }
  const COLOR = new Map();
  async function getColor(uri, image) {
    const hit = lruGet(COLOR, uri);
    if (hit) return hit;
    const disk = await DB.get("c:" + uri);
    if (disk && disk.v) return lruSet(COLOR, uri, disk.v, 300);
    let rgb = null;
    try {
      if (S.colorExtractor) {
        const c = await S.colorExtractor(uri);
        rgb = rgbFromHex(c && (c.VIBRANT || c.PROMINENT || c.DESATURATED));
      }
    } catch (e) {}
    if (!rgb && image) rgb = await canvasColor(image);
    if (!rgb) rgb = [40, 40, 48];
    const [r, g, b] = rgb;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const k = lum > 150 ? 150 / lum : 1;
    rgb = [r * k, g * k, b * k].map(Math.round);
    DB.put("c:" + uri, rgb);
    return lruSet(COLOR, uri, rgb, 300);
  }

  // ================= icons =================
  const STROKE = 'viewBox="0 0 24 24" style="fill:none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const I = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4.2" height="16" rx="1.2"/><rect x="13.8" y="4" width="4.2" height="16" rx="1.2"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="2.4" height="14" rx="1"/><path d="M19.5 5.9v12.2a1 1 0 0 1-1.53.85L8.7 13.1a1.3 1.3 0 0 1 0-2.2l9.27-5.85a1 1 0 0 1 1.53.85z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><rect x="17.6" y="5" width="2.4" height="14" rx="1"/><path d="M4.5 5.9v12.2a1 1 0 0 0 1.53.85l9.27-5.85a1.3 1.3 0 0 0 0-2.2L6.03 5.05A1 1 0 0 0 4.5 5.9z"/></svg>',
    shuffle: `<svg ${STROKE}><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/></svg>`,
    repeat: `<svg ${STROKE}><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`,
    repeat1: `<svg ${STROKE}><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4" stroke-width="1.8"/></svg>`,
    heart: `<svg ${STROKE}><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.5 4.5 7 4.5c2.2 0 3.6 1.2 5 3 1.4-1.8 2.8-3 5-3 3.5 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>`,
    heartFill: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.5 4.5 7 4.5c2.2 0 3.6 1.2 5 3 1.4-1.8 2.8-3 5-3 3.5 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>',
    close: `<svg ${STROKE} stroke-width="2.2"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    full: `<svg ${STROKE}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
    lyrics: `<svg ${STROKE}><path d="M4 6h11M4 11h16M4 16h8"/><circle cx="17.5" cy="17.5" r="2.5"/><path d="M20 17.5V9"/></svg>`,
    queue: `<svg ${STROKE}><path d="M4 6h16M4 12h10M4 18h10"/><path d="m17 14 4 3-4 3z" style="fill:currentColor"/></svg>`,
    pip: `<svg ${STROKE}><rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11" width="7" height="6" rx="1.2" style="fill:currentColor;stroke:none"/></svg>`,
    gear: `<svg ${STROKE}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
    help: `<svg ${STROKE}><circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.5-2.7 4"/><path d="M12 17.6h.01" stroke-width="2.6"/></svg>`,
    vol: `<svg ${STROKE}><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z" style="fill:currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`,
    volLow: `<svg ${STROKE}><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z" style="fill:currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>`,
    mute: `<svg ${STROKE}><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z" style="fill:currentColor"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>`,
    moon: `<svg ${STROKE}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>`,
    wave: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="6" width="1.6" height="4" rx=".8"/><rect x="4" y="3.5" width="1.6" height="9" rx=".8"/><rect x="7" y="1.5" width="1.6" height="13" rx=".8"/><rect x="10" y="4.5" width="1.6" height="7" rx=".8"/><rect x="13" y="6.5" width="1.6" height="3" rx=".8"/></svg>',
  };

  const NOISE =
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";
  const FONT_IMPORT = "@import url('https://fonts.googleapis.com/css2?family=Unbounded:wght@600;800&display=swap');";
  const TITLE_FONT = `"Unbounded","SpotifyMixUITitle",var(--encore-title-font-stack,sans-serif)`;

  // ================= styles =================
  const R = "#" + ID;
  const css = `
  ${FONT_IMPORT}
  ${R}{position:fixed;inset:0;z-index:99999;color:#fff;overflow:hidden;opacity:0;pointer-events:none;
    transition:opacity .35s ease;font-family:var(--encore-body-font-stack,"SpotifyMixUI",system-ui,sans-serif);
    --c:40,40,48;background:rgb(var(--c));user-select:none}
  ${R}.open{opacity:1;pointer-events:auto}
  ${R} button{all:unset;box-sizing:border-box;cursor:pointer}
  ${R}.idle{cursor:none}
  ${R}.idle .v-top,${R}.idle .v-chip{opacity:0}

  ${R} .v-bgwrap{position:absolute;inset:0;will-change:transform}
  ${R} .v-bg{position:absolute;left:-12%;top:-12%;width:124%;height:124%;transform:scale(1.15);opacity:.85;transition:opacity 1.2s ease}
  html.volna-under body > *:not(#${ID}){visibility:hidden !important}
  ${R}.live .v-bg{animation:volnaDrift 38s ease-in-out infinite alternate}
  ${R}.live .v-bg+.v-bg{animation-duration:46s;animation-direction:alternate-reverse}
  @keyframes volnaDrift{0%{transform:scale(1.15) rotate(0deg) translate(0,0)}50%{transform:scale(1.35) rotate(8deg) translate(3%,-2%)}100%{transform:scale(1.25) rotate(-6deg) translate(-3%,2%)}}
  ${R} .v-bg.hide{opacity:0}
  ${R} .v-tint{position:absolute;inset:0;transition:background 1.2s ease;
    background:radial-gradient(120% 90% at 30% 40%,rgba(var(--c),.55) 0%,rgba(var(--c),.75) 55%,rgba(0,0,0,.55) 100%)}
  ${R} .v-noise{position:absolute;inset:0;background-image:${NOISE};opacity:.09;mix-blend-mode:overlay;pointer-events:none}
  ${R} .v-shade{position:absolute;left:0;right:0;bottom:0;height:45%;background:linear-gradient(transparent,rgba(0,0,0,.35));pointer-events:none}

  ${R} .v-top{position:absolute;top:22px;right:26px;display:flex;gap:8px;z-index:9;transition:opacity .4s}
  ${R} .v-top button{width:38px;height:38px;display:grid;place-items:center;border-radius:50%;color:rgba(255,255,255,.75);
    background:rgba(0,0,0,.18);transition:background .15s,color .15s}
  ${R} .v-top button:hover{background:rgba(0,0,0,.32);color:#fff}
  ${R} .v-top button.on{background:rgba(255,255,255,.92);color:#111}
  ${R} .v-top svg{width:18px;height:18px}
  ${R} .v-chip{position:absolute;top:28px;left:32px;z-index:9;display:none;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;
    background:rgba(0,0,0,.22);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;transition:opacity .4s;cursor:pointer}
  ${R} .v-chip.show{display:flex}
  ${R} .v-chip svg{width:14px;height:14px}

  ${R} .v-osd{position:absolute;top:28px;left:50%;transform:translate(-50%,-10px);opacity:0;padding:9px 16px;border-radius:999px;
    background:rgba(0,0,0,.45);backdrop-filter:blur(12px);font-size:13px;font-weight:600;z-index:12;transition:opacity .25s,transform .25s;pointer-events:none;white-space:nowrap}
  ${R} .v-osd.show{opacity:1;transform:translate(-50%,0)}

  ${R} .v-main{position:absolute;inset:0;display:grid;grid-template-rows:minmax(0,1fr) auto;padding:6vh 6vw 4vh;z-index:2;transition:padding-right .35s}
  ${R}.q .v-main{padding-right:calc(min(400px,90vw) + 3vw)}
  ${R} .v-hero{display:flex;align-items:center;gap:5vw;min-height:0}
  ${R} .v-left{display:flex;align-items:center;gap:5vw;min-width:0;flex:1}
  ${R} .v-cover{flex:none;width:min(42vh,34vw);aspect-ratio:1;border-radius:14px;background:rgba(0,0,0,.2) center/cover;will-change:transform;
    box-shadow:0 30px 80px rgba(0,0,0,.45),0 8px 24px rgba(0,0,0,.25);transition:width .5s cubic-bezier(.2,.8,.2,1),opacity .4s}
  ${R} .v-cover.swap{opacity:.35}
  ${R} .v-cover{position:relative}
  ${R} .v-viz{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1}
  ${R}.vizon .v-left{gap:10vw}
  ${R}.vizon:not(.lyr) .v-cover{margin-left:5vw}
  ${R}.vizon:not(.lyr) .v-meta{margin-left:4vw}
  /* lyrics view + visualizer: smaller cover and more room below it so rays never reach the title */
  ${R}.vizon.lyr .v-cover{width:min(26vw,30vh)}
  ${R}.vizon.lyr .v-left{gap:11vh}
  ${R} .v-meta{min-width:0;flex:1;transition:opacity .3s,transform .4s}
  ${R} .v-meta.swap{opacity:0;transform:translateY(8px)}
  ${R} .v-label{display:flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.18em;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,.7)}
  ${R} .v-dot{width:7px;height:7px;border-radius:50%;background:#fff}
  ${R}.playing .v-dot{animation:volnaPulse 1.8s infinite}
  @keyframes volnaPulse{0%{box-shadow:0 0 0 0 rgba(255,255,255,.55)}80%,100%{box-shadow:0 0 0 9px rgba(255,255,255,0)}}
  ${R} .v-title{font-family:${TITLE_FONT};font-weight:800;font-size:clamp(34px,6.2vw,96px);line-height:1.02;letter-spacing:-.02em;margin:14px 0;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-wrap:balance;word-break:break-word;transition:font-size .4s}
  ${R} .v-artist{font-size:clamp(16px,1.6vw,24px);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  ${R} .v-album{margin-top:6px;font-size:clamp(13px,1.05vw,16px);color:rgba(255,255,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  ${R} .v-link{cursor:pointer;text-decoration:none;text-underline-offset:3px}
  ${R} .v-link:hover{text-decoration:underline}
  ${R} .v-next{margin-top:28px;font-size:13px;color:rgba(255,255,255,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
  ${R} .v-next:hover{color:rgba(255,255,255,.8)}
  ${R} .v-next b{color:rgba(255,255,255,.85);font-weight:600}

  /* lyrics view */
  ${R} .v-lyrics{display:none;position:relative;flex:1;min-width:0;align-self:stretch;overflow:hidden;
    -webkit-mask-image:linear-gradient(transparent,#000 16%,#000 78%,transparent);mask-image:linear-gradient(transparent,#000 16%,#000 78%,transparent)}
  ${R}.lyr .v-lyrics{display:block}
  ${R}.lyr .v-left{flex:0 0 auto;width:min(30vw,44vh);flex-direction:column;align-items:flex-start;gap:3vh;align-self:center}
  ${R}.lyr .v-cover{width:min(30vw,36vh)}
  ${R}.lyr .v-meta{width:100%}
  ${R}.lyr .v-title{font-size:clamp(24px,2.6vw,44px);margin:10px 0}
  ${R}.lyr .v-next{display:none}
  ${R} .v-lyr-inner{position:absolute;left:0;right:0;top:0;padding:0 1vw 0 0;transition:transform .7s cubic-bezier(.2,.8,.2,1)}
  ${R} .v-line{font-family:"SpotifyMixUITitle",var(--encore-title-font-stack,sans-serif);font-weight:800;font-size:clamp(22px,2.5vw,42px);line-height:1.22;
    margin:0 0 .55em;color:rgba(255,255,255,.42);cursor:pointer;transform-origin:left center;transition:color .35s,transform .35s,filter .35s;text-wrap:pretty}
  ${R} .v-line.past{color:rgba(255,255,255,.26)}
  ${R} .v-line.on{color:#fff;transform:scale(1.025)}
  ${R} .v-line.far{filter:blur(1.2px)}
  ${R} .v-line:hover{color:rgba(255,255,255,.7);filter:none}
  ${R} .v-w{border-radius:6px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
  ${R} .v-line.on .v-w{color:transparent;-webkit-background-clip:text;background-clip:text;
    background-image:linear-gradient(90deg,#fff var(--p,-8%),rgba(255,255,255,.42) calc(var(--p,-8%) + 8%))}
  ${R} .v-line.on .v-w.d{--p:100%}
  ${R} .v-lyrics.unsynced{overflow-y:auto;-webkit-mask-image:none;mask-image:none;scrollbar-width:thin}
  ${R} .v-lyrics.unsynced .v-lyr-inner{position:static;padding-bottom:20vh}
  ${R} .v-lyrics.unsynced .v-line{color:rgba(255,255,255,.85);cursor:default;font-size:clamp(18px,1.8vw,30px)}
  ${R} .v-lyr-msg{position:absolute;inset:0;display:grid;place-items:center;font-size:18px;color:rgba(255,255,255,.6);text-align:center;pointer-events:none}
  ${R} .v-lyr-msg:empty{display:none}
  ${R} .v-lyr-src{position:absolute;right:1vw;bottom:4px;font-size:11px;color:rgba(255,255,255,.45);pointer-events:none}

  /* bottom */
  ${R} .v-bottom{display:flex;flex-direction:column;gap:2.4vh;padding-top:2vh}
  ${R} .v-wave-row{display:flex;align-items:center;gap:18px;font-size:12px;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.75)}
  ${R} .v-wave-row>span{min-width:40px}
  ${R} .v-dur{text-align:right;cursor:pointer}
  ${R} .v-wave{flex:1;height:64px;cursor:pointer;position:relative}
  ${R} canvas{width:100%;height:100%;display:block}
  ${R} .v-tip{position:absolute;top:-26px;transform:translateX(-50%);padding:3px 7px;border-radius:6px;background:rgba(0,0,0,.55);font-size:11px;opacity:0;pointer-events:none;transition:opacity .15s}
  ${R} .v-wave:hover .v-tip{opacity:1}
  ${R} .v-ctlrow{display:grid;grid-template-columns:1fr auto 1fr;align-items:center}
  ${R} .v-ctl{display:flex;align-items:center;justify-content:center;gap:26px}
  ${R} .v-ctlrow button{width:40px;height:40px;display:grid;place-items:center;border-radius:50%;color:rgba(255,255,255,.72);position:relative;transition:transform .15s,color .15s}
  ${R} .v-ctlrow button svg{width:20px;height:20px;fill:currentColor}
  ${R} .v-ctlrow button:hover{color:#fff;transform:scale(1.08)}
  ${R} .v-ctlrow button.on{color:#fff}
  ${R} .v-ctlrow button.on::after{content:"";position:absolute;bottom:1px;left:50%;margin-left:-2px;width:4px;height:4px;border-radius:50%;background:#fff}
  ${R} .v-ctlrow button.liked{color:#1ed760}
  ${R} .v-ctl .v-play{width:64px;height:64px;background:#fff;color:#111;box-shadow:0 10px 30px rgba(0,0,0,.3)}
  ${R} .v-ctl .v-play svg{width:24px;height:24px}
  ${R} .v-ctl .v-play:hover{color:#000;transform:scale(1.06)}
  ${R} .v-ctl-l{justify-self:start;display:flex;gap:6px}
  ${R} .v-ctl-r{justify-self:end;display:flex;align-items:center;gap:6px}
  ${R} .v-volhit{width:110px;padding:10px 0;cursor:pointer}
  ${R} .v-vol{height:4px;border-radius:2px;background:rgba(255,255,255,.25);position:relative;overflow:hidden}
  ${R} .v-vol i{position:absolute;left:0;top:0;bottom:0;background:#fff;border-radius:2px}

  /* queue */
  ${R} .v-queue{position:absolute;top:0;right:0;bottom:0;width:min(400px,90vw);z-index:8;display:flex;flex-direction:column;
    background:rgba(10,10,14,.32);backdrop-filter:blur(26px) saturate(1.3);border-left:1px solid rgba(255,255,255,.08);
    transform:translateX(102%);transition:transform .35s cubic-bezier(.2,.8,.2,1)}
  ${R}.q .v-queue{transform:none}
  ${R} .v-qhead{padding:30px 24px 10px;font-family:${TITLE_FONT};font-weight:800;font-size:20px}
  ${R} .v-qlist{flex:1;overflow-y:auto;padding:0 8px 24px;scrollbar-width:thin}
  ${R} .v-qsec{padding:16px 16px 6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:rgba(255,255,255,.55)}
  ${R} .v-qi{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;align-items:center;padding:7px 16px;border-radius:10px}
  ${R} .v-qi.click{cursor:pointer}
  ${R} .v-qi.click:hover{background:rgba(255,255,255,.08)}
  ${R} .v-qi img,${R} .v-qi .ph{width:44px;height:44px;border-radius:6px;object-fit:cover;background:rgba(255,255,255,.1)}
  ${R} .v-qt{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  ${R} .v-qa{font-size:12px;color:rgba(255,255,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
  ${R} .v-qd{font-size:12px;color:rgba(255,255,255,.5);font-variant-numeric:tabular-nums}
  ${R} .v-qempty{padding:24px;color:rgba(255,255,255,.55);font-size:14px}

  /* settings */
  ${R} .v-pop{position:absolute;top:72px;right:26px;width:340px;max-height:calc(100vh - 100px);overflow-y:auto;padding:16px 18px;border-radius:16px;z-index:10;
    background:rgba(14,14,18,.62);backdrop-filter:blur(26px);box-shadow:0 20px 60px rgba(0,0,0,.35);
    opacity:0;pointer-events:none;transform:translateY(-6px);transition:opacity .2s,transform .2s}
  ${R} .v-pop.show{opacity:1;pointer-events:auto;transform:none}
  ${R} .v-pop h3{margin:0 0 8px;font-family:${TITLE_FONT};font-size:16px;font-weight:800}
  ${R} .v-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;font-size:13px;border-top:1px solid rgba(255,255,255,.07)}
  ${R} .v-row small{display:block;color:rgba(255,255,255,.5);font-size:11px;margin-top:2px}
  ${R} .v-row.col{flex-direction:column;align-items:stretch}
  ${R} .v-sw{flex:none;width:36px;height:20px;border-radius:10px;background:rgba(255,255,255,.22);position:relative;transition:background .2s}
  ${R} .v-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .2s}
  ${R} .v-sw.on{background:#1ed760}
  ${R} .v-sw.on::after{left:18px}
  ${R} .v-seg{display:flex;flex-wrap:wrap;gap:5px}
  ${R} .v-seg button{padding:5px 10px;border-radius:999px;font-size:12px;background:rgba(255,255,255,.1);color:rgba(255,255,255,.85)}
  ${R} .v-seg button:hover{background:rgba(255,255,255,.18)}
  ${R} .v-seg button.on{background:#fff;color:#111}

  /* help */
  ${R} .v-help{position:absolute;inset:0;display:grid;place-items:center;z-index:11;background:rgba(0,0,0,.4);backdrop-filter:blur(8px);
    opacity:0;pointer-events:none;transition:opacity .2s}
  ${R} .v-help.show{opacity:1;pointer-events:auto}
  ${R} .v-help-card{width:min(640px,90vw);padding:26px 30px;border-radius:20px;background:rgba(14,14,18,.6);box-shadow:0 30px 80px rgba(0,0,0,.4)}
  ${R} .v-help-card h3{margin:0 0 16px;font-family:${TITLE_FONT};font-weight:800;font-size:22px}
  ${R} .v-keys{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px 28px;font-size:14px}
  ${R} .v-keys div{display:flex;justify-content:space-between;gap:12px;align-items:center}
  ${R} .v-keys span{color:rgba(255,255,255,.75)}
  ${R} kbd{font:600 12px var(--encore-body-font-stack,sans-serif);padding:3px 7px;border-radius:6px;background:rgba(255,255,255,.14);border-bottom:2px solid rgba(255,255,255,.12);white-space:nowrap}
  ${R} .v-help-foot{margin-top:18px;font-size:12px;color:rgba(255,255,255,.5)}

  @media (max-width:900px),(max-height:560px){
    ${R} .v-left{flex-direction:column;justify-content:center;align-items:flex-start;gap:3vh}
    ${R} .v-cover{width:min(30vh,60vw)}
    ${R} .v-title{font-size:clamp(26px,7vw,56px)}
    ${R} .v-keys{grid-template-columns:1fr}
  }
  `;

  // ================= DOM =================
  const style = document.createElement("style");
  style.id = ID + "-style";
  style.textContent = css;
  document.head.appendChild(style);

  const KEYS = [
    ["Открыть / закрыть", "Ctrl+Shift+V"], ["Пауза / играть", "Пробел"],
    ["Перемотка ±5 с", "← →"], ["Пред. / след. трек", "Ctrl+← →"],
    ["Громкость", "↑ ↓ / колесо"], ["Без звука", "M"],
    ["Текст песни", "T"], ["Очередь", "Q"],
    ["Мини-плеер поверх окон", "P"], ["Во весь экран", "F"],
    ["В любимые", "L"], ["Перемешать", "S"],
    ["Повтор", "R"], ["Настройки", ","],
    ["Текст раньше / позже", "] ["], ["Стиль визуализатора", "V"],
    ["Эта шпаргалка", "H"], ["Закрыть", "Esc"],
  ];

  const root = document.createElement("div");
  root.id = ID;
  root.innerHTML = `
    <div class="v-bgwrap"><canvas class="v-bg"></canvas><canvas class="v-bg hide"></canvas></div>
    <div class="v-tint"></div><div class="v-noise"></div><div class="v-shade"></div><canvas class="v-viz"></canvas>
    <div class="v-chip" title="Таймер сна — нажми, чтобы отменить">${I.moon}<span></span></div>
    <div class="v-osd"></div>
    <div class="v-top">
      <button data-a="lyrics" title="Текст песни (T)">${I.lyrics}</button>
      <button data-a="queue" title="Очередь (Q)">${I.queue}</button>
      <button data-a="pip" title="Мини-плеер поверх окон (P)">${I.pip}</button>
      <button data-a="settings" title="Настройки (,)">${I.gear}</button>
      <button data-a="help" title="Горячие клавиши (H)">${I.help}</button>
      <button data-a="full" title="Во весь экран (F)">${I.full}</button>
      <button data-a="close" title="Закрыть (Esc)">${I.close}</button>
    </div>
    <div class="v-main">
      <div class="v-hero">
        <div class="v-left">
          <div class="v-cover"></div>
          <div class="v-meta">
            <div class="v-label"><i class="v-dot"></i><span class="v-state">Сейчас играет</span></div>
            <div class="v-title"></div>
            <div class="v-artist"></div>
            <div class="v-album"></div>
            <div class="v-next"></div>
          </div>
        </div>
        <div class="v-lyrics"><div class="v-lyr-inner"></div><div class="v-lyr-msg"></div><div class="v-lyr-src"></div></div>
      </div>
      <div class="v-bottom">
        <div class="v-wave-row">
          <span class="v-cur">0:00</span>
          <div class="v-wave"><canvas></canvas><div class="v-tip">0:00</div></div>
          <span class="v-dur" title="Нажми: длительность / сколько осталось">0:00</span>
        </div>
        <div class="v-ctlrow">
          <div class="v-ctl-l"><button class="v-heart" title="В любимые (L)">${I.heart}</button><button class="v-lyrbtn" title="Текст песни вкл/выкл (T)">${I.lyrics}</button></div>
          <div class="v-ctl">
            <button class="v-shuffle" title="Перемешать (S)">${I.shuffle}</button>
            <button class="v-prev" title="Назад (Ctrl+←)">${I.prev}</button>
            <button class="v-play" title="Пауза / играть (Пробел)">${I.pause}</button>
            <button class="v-next-btn" title="Вперёд (Ctrl+→)">${I.next}</button>
            <button class="v-repeat" title="Повтор (R)">${I.repeat}</button>
          </div>
          <div class="v-ctl-r">
            <button class="v-mute" title="Без звука (M)">${I.vol}</button>
            <div class="v-volhit" title="Громкость (↑ ↓, колесо мыши)"><div class="v-vol"><i></i></div></div>
          </div>
        </div>
      </div>
    </div>
    <aside class="v-queue"><div class="v-qhead">Очередь</div><div class="v-qlist"></div></aside>
    <div class="v-pop"></div>
    <div class="v-help"><div class="v-help-card"><h3>Горячие клавиши</h3>
      <div class="v-keys">${KEYS.map(([a, k]) => `<div><span>${a}</span><kbd>${k}</kbd></div>`).join("")}</div>
      <div class="v-help-foot">Клик по волне — перемотка, по слову в тексте — прыжок к этому слову, по артисту или альбому — открыть его страницу. Двойной клик по обложке — во весь экран.</div>
    </div></div>`;
  document.body.appendChild(root);

  const el = {
    bgwrap: $(".v-bgwrap", root), bgs: root.querySelectorAll(".v-bg"),
    cover: $(".v-cover", root), viz: $(".v-viz", root), meta: $(".v-meta", root),
    title: $(".v-title", root), artist: $(".v-artist", root), album: $(".v-album", root),
    next: $(".v-next", root), state: $(".v-state", root),
    cur: $(".v-cur", root), dur: $(".v-dur", root),
    wave: $(".v-wave", root), canvas: $(".v-wave canvas", root), tip: $(".v-tip", root),
    lyrbtn: $(".v-lyrbtn", root), play: $(".v-play", root), shuffle: $(".v-shuffle", root), repeat: $(".v-repeat", root), heart: $(".v-heart", root),
    mute: $(".v-mute", root), volhit: $(".v-volhit", root), volFill: $(".v-vol i", root),
    lyrics: $(".v-lyrics", root), lyrInner: $(".v-lyr-inner", root), lyrMsg: $(".v-lyr-msg", root), lyrSrc: $(".v-lyr-src", root),
    qlist: $(".v-qlist", root), pop: $(".v-pop", root), help: $(".v-help", root),
    osd: $(".v-osd", root), chip: $(".v-chip", root), chipText: $(".v-chip span", root),
  };
  const topBtn = (a) => $(`.v-top [data-a="${a}"]`, root);

  // ================= state =================
  let isOpen = false;
  let cur = null;           // info() of current track
  let audio = { peaks: fakePeaks("init"), beats: [], onsets: [], real: false };
  let lyr = { uri: null, status: "none", data: null };
  let lyrIdx = -2, lineEls = [], wordEls = [], timing = [], wordIdx = -2;
  let activeBg = 0, raf = 0, hoverX = -1, idleTimer = 0, osdTimer = 0;
  let lastChangeAt = 0, settleTimer = 0;
  // smooth colour transitions: --c glides to the new track's colour instead of jumping
  const colorNow = [40, 40, 48], colorTarget = [40, 40, 48];
  function setColor(rgb) {
    colorTarget.splice(0, 3, ...rgb);
    if (pip) pip.doc.documentElement.style.setProperty("--c", rgb.join(","));
    if (!isOpen) { colorNow.splice(0, 3, ...rgb); applyColor(); }
  }
  function applyColor() {
    const c = colorNow.map(Math.round);
    root.style.setProperty("--c", c.join(","));
    vizSetColor(c);
  }
  function stepColor() {
    let moved = false;
    for (let k = 0; k < 3; k++) {
      const d = colorTarget[k] - colorNow[k];
      if (Math.abs(d) > 0.4) { colorNow[k] += d * 0.06; moved = true; } else colorNow[k] = colorTarget[k];
    }
    if (moved) applyColor();
  }
  // waveform morphs into the new track's shape
  let shownPeaks = new Float32Array(400);
  let mouse = { x: 0.5, y: 0.5 }, tilt = { x: 0, y: 0 }, beatIdx = 0;
  let sleep = { until: 0, track: false };
  let queueSig = "";
  let lastActivity = Date.now();

  function osd(text, ms = 1400) {
    el.osd.textContent = text;
    el.osd.classList.add("show");
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => el.osd.classList.remove("show"), ms);
    if (pip) pipOsd(text);
  }

  // ================= track updates =================
  function renderArtists(container, artists) {
    container.innerHTML = artists
      .map((a, i) => `<span class="v-link" data-uri="${esc(a.uri || "")}">${esc(a.name)}</span>${i < artists.length - 1 ? ", " : ""}`)
      .join("");
  }

  function updateTrack() {
    const i = info();
    if (!i) {
      el.title.textContent = "Ничего не играет";
      el.artist.textContent = el.album.textContent = el.next.textContent = "";
      return;
    }
    const changed = !cur || i.uri !== cur.uri;
    const rapid = changed && Date.now() - lastChangeAt < 1200; // user is skipping fast
    cur = i;
    el.dur.dataset.ms = i.duration;

    const fill = () => {
      if (cur !== i) return; // a newer track arrived meanwhile
      el.title.textContent = i.title;
      renderArtists(el.artist, i.artists);
      el.album.innerHTML = i.album ? `<span class="v-link" data-uri="${esc(i.albumUri)}">${esc(i.album)}</span>` : "";
      el.meta.classList.remove("swap");
    };
    if (changed && isOpen && el.title.textContent && !rapid) {
      el.meta.classList.add("swap");
      setTimeout(fill, 250);
    } else fill();

    if (changed) {
      if (i.image) {
        el.cover.classList.add("swap");
        loadImg(i.image).then((img) => {
          if (cur !== i) return;
          el.cover.style.backgroundImage = `url("${i.image}")`;
          el.cover.classList.remove("swap");
          if (!img) return;
          const nextBg = el.bgs[activeBg ^ 1];
          paintBg(nextBg, img);
          nextBg.classList.remove("hide");
          el.bgs[activeBg].classList.add("hide");
          activeBg ^= 1;
        });
      }
      audio = { peaks: fakePeaks(i.uri), beats: [], onsets: [], real: false };
      beatIdx = 0;
      clock.ms = 0;
      lyr = { uri: i.uri, status: "loading", data: null };
      renderLyrics();
      if (pip) pipTrack();
      lastChangeAt = Date.now();
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (cur !== i) return;
        getColor(i.uri, i.image).then((rgb) => { if (cur === i) setColor(rgb); });
        analysis(i.uri).then((a) => { if (cur === i) { audio = a; computeTiming(); } });
        loadLyrics(i);
        schedulePrefetch();
      }, rapid ? 350 : 0);
    }
    updateNext();
    updateButtons();
  }

  // decoded-image cache shared by the cover, the background and next-track prefetch
  const IMG = new Map();
  function loadImg(url) {
    if (!url) return Promise.resolve(null);
    if (!IMG.has(url)) {
      IMG.set(url, new Promise((res) => {
        const im = new Image();
        im.decoding = "async";
        im.onload = () => (im.decode ? im.decode().catch(() => {}) : Promise.resolve()).then(() => res(im));
        im.onerror = () => res(null);
        im.src = url;
      }));
      while (IMG.size > 16) IMG.delete(IMG.keys().next().value);
    }
    return lruGet(IMG, url);
  }
  // blur once at ~128px; the browser just stretches the result (was: 90px CSS blur on a full-screen layer)
  function paintBg(cv, img) {
    const w = 128, h = Math.max(48, Math.round((128 * window.innerHeight) / Math.max(1, window.innerWidth)));
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.filter = "blur(6px) saturate(1.6) brightness(0.9)";
    const sz = Math.max(w, h) * 1.3;
    ctx.drawImage(img, (w - sz) / 2, (h - sz) / 2, sz, sz);
  }

  // warm every cache for the next track so the switch itself has nothing left to load
  let prefetchTimer = 0, prefetchGen = 0;
  function schedulePrefetch() { clearTimeout(prefetchTimer); prefetchTimer = setTimeout(prefetchNeighbours, 1500); }
  function prevTracks() {
    try {
      return ((S.Queue && S.Queue.prevTracks) || []).filter(
        (t) => t && t.contextTrack && t.contextTrack.uri && t.contextTrack.uri.startsWith("spotify:track:") && t.contextTrack.metadata && t.contextTrack.metadata.title
      ).slice(-2).reverse(); // nearest first
    } catch (e) { return []; }
  }
  function prefetchOne(t) {
    const m = t.contextTrack.metadata, uri = t.contextTrack.uri;
    if (!uri.startsWith("spotify:track:")) return;
    const imgs = [m.image_xlarge_url, m.image_large_url, m.image_url].filter(Boolean).map(imgUrl);
    if (imgs[0]) loadImg(imgs[0]);
    analysis(uri);
    getColor(uri, imgs[0]);
    lyricsFor({ uri, title: m.title, artists: [{ name: m.artist_name }], album: m.album_title || "", duration: +m.duration || 0 });
  }
  function prefetchNeighbours() {
    if (!(isOpen || pip)) return;
    const next = nextTracks(), prev = prevTracks();
    const order = [next[0], prev[0], next[1], next[2], prev[1]].filter(Boolean);
    const gen = ++prefetchGen;
    order.forEach((t, k) => setTimeout(() => { if (gen === prefetchGen && (isOpen || pip)) prefetchOne(t); }, k * 500));
  }

  function nextTracks() {
    try {
      return ((S.Queue && S.Queue.nextTracks) || []).filter(
        (t) => t && t.contextTrack && t.contextTrack.uri && !t.contextTrack.uri.startsWith("spotify:delimiter") && t.contextTrack.metadata && t.contextTrack.metadata.title
      );
    } catch (e) { return []; }
  }

  function updateNext() {
    const n = nextTracks()[0];
    el.next.innerHTML = n ? `Далее: <b>${esc(n.contextTrack.metadata.title)}</b> — ${esc(n.contextTrack.metadata.artist_name || "")}` : "";
    if (root.classList.contains("q")) renderQueue();
  }

  function updateButtons() {
    const playing = S.Player.isPlaying();
    el.play.innerHTML = playing ? I.pause : I.play;
    root.classList.toggle("playing", playing);
    el.state.textContent = playing ? "Сейчас играет" : "На паузе";
    let v;
    try { v = S.Player.getShuffle(); } catch (e) {}
    el.shuffle.classList.toggle("on", !!v);
    let rep = 0;
    try { rep = S.Player.getRepeat() || 0; } catch (e) {}
    el.repeat.classList.toggle("on", rep > 0);
    el.repeat.innerHTML = rep === 2 ? I.repeat1 : I.repeat;
    let liked = false;
    try { liked = S.Player.getHeart(); } catch (e) {}
    el.heart.classList.toggle("liked", !!liked);
    el.heart.innerHTML = liked ? I.heartFill : I.heart;
    updateVolume();
    if (pip) pipButtons();
  }

  let preMute = 0; // volume before mute (own implementation: Spicetify.Player.toggleMute is a no-op in some builds)
  function volume() { try { return S.Player.getVolume() || 0; } catch (e) { return 0; } }
  function isMuted() { return volume() === 0; }
  function updateVolume() {
    const v = volume();
    el.volFill.style.width = Math.round(v * 100) + "%";
    el.mute.innerHTML = v === 0 ? I.mute : v < 0.5 ? I.volLow : I.vol;
  }
  function setVolume(v, silent) {
    v = clamp(Math.round(v * 100) / 100, 0, 1);
    S.Player.setVolume(v);
    if (!silent) osd(v === 0 ? "Звук выключен" : `Громкость ${Math.round(v * 100)}%`);
    setTimeout(updateVolume, 60);
  }
  function toggleMute() {
    const v = volume();
    if (v > 0) { preMute = v; setVolume(0, true); osd("Звук выключен"); }
    else { setVolume(preMute || 0.5, true); osd(`Громкость ${Math.round((preMute || 0.5) * 100)}%`); }
  }
  function cycleRepeat() {
    let r = 0;
    try { r = S.Player.getRepeat() || 0; } catch (e) {}
    r = (r + 1) % 3;
    S.Player.setRepeat(r);
    osd(["Повтор выключен", "Повтор плейлиста", "Повтор трека"][r]);
    setTimeout(updateButtons, 200);
  }
  function toggleShuffle() {
    S.Player.toggleShuffle();
    setTimeout(() => { updateButtons(); let v = false; try { v = S.Player.getShuffle(); } catch (e) {} osd(v ? "Перемешивание включено" : "Перемешивание выключено"); }, 250);
  }
  function toggleHeart() {
    S.Player.toggleHeart();
    setTimeout(() => { updateButtons(); let v = false; try { v = S.Player.getHeart(); } catch (e) {} osd(v ? "Добавлено в любимые" : "Убрано из любимых"); }, 400);
  }

  // ================= lyrics view =================
  function loadLyrics(i) {
    lyr = { uri: i.uri, status: "loading", data: null };
    renderLyrics();
    lyricsFor(i).then((d) => {
      if (!cur || cur.uri !== i.uri) return;
      lyr = { uri: i.uri, status: d ? "ok" : "none", data: d };
      renderLyrics();
    });
  }

  function renderLyrics() {
    lyrIdx = -2;
    el.lyrics.classList.remove("unsynced");
    el.lyrInner.style.transform = "";
    el.lyrSrc.textContent = "";
    applyView();
    if (lyr.status !== "ok") {
      el.lyrInner.innerHTML = "";
      lineEls = []; wordEls = []; timing = [];
      el.lyrMsg.textContent = lyr.status === "loading" ? "Ищу текст…" : "Текста для этого трека не нашлось";
      return;
    }
    el.lyrMsg.textContent = "";
    const d = lyr.data;
    el.lyrics.classList.toggle("unsynced", !d.synced);
    for (const l of d.lines) if (!l.tokens) l.tokens = (l.text || "♪").split(/\s+/).filter(Boolean).map((w) => ({ text: w, t: null }));
    el.lyrInner.innerHTML = d.lines
      .map((l, i) => `<div class="v-line" data-i="${i}">${l.tokens.map((w, k) => `<span class="v-w" data-w="${k}">${esc(w.text)}</span>`).join(" ")}</div>`)
      .join("");
    lineEls = [...el.lyrInner.children];
    wordEls = lineEls.map((le) => [...le.querySelectorAll(".v-w")]);
    computeTiming();
    const exact = d.lines.some((l) => l.tokens.some((w) => w.t != null));
    el.lyrSrc.textContent = (d.synced ? (exact ? "Пословная синхронизация · " : "Слова — по ритму трека · ") : "Без синхронизации · ") + "Текст: " + d.source;
    el.lyrics.scrollTop = 0;
  }

  // Per-word start times. Exact when the source has them, otherwise spread across the line by
  // word length and snapped to note onsets from Spotify's audio analysis.
  function nearestOnset(t, win) {
    const o = audio.onsets || [];
    let lo = 0, hi = o.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (o[m] < t) lo = m + 1; else hi = m; }
    let best = null;
    for (const k of [lo - 1, lo]) if (o[k] != null && Math.abs(o[k] - t) <= win && (best == null || Math.abs(o[k] - t) < Math.abs(best - t))) best = o[k];
    return best;
  }
  function computeTiming() {
    wordIdx = -2;
    if (lyr.status !== "ok" || !lyr.data.synced) { timing = []; return; }
    const L = lyr.data.lines;
    timing = L.map((l, i) => {
      const nextT = i + 1 < L.length ? L[i + 1].t : l.t + 6000;
      const gap = Math.max(300, nextT - l.t);
      const toks = l.tokens;
      const chars = toks.map((w) => w.text.length + 1);
      const total = chars.reduce((a, b) => a + b, 0) || 1;
      const sing = Math.min(gap * 0.92, Math.max(900, total * 65));
      let acc = 0;
      const times = toks.map((w, k) => {
        let t = w.t;
        if (t == null) {
          t = l.t + (sing * acc) / total;
          if (k > 0) { const s = nearestOnset(t, 170); if (s != null) t = s; }
        }
        acc += chars[k];
        return t;
      });
      times[0] = Math.min(times[0], l.t);
      for (let k = 1; k < times.length; k++) if (times[k] <= times[k - 1]) times[k] = times[k - 1] + 60;
      const end = Math.min(nextT, Math.max(l.t + sing, times[times.length - 1] + 350));
      return { times, end };
    });
  }

  function syncWords(ms, li) {
    const tm = timing[li], words = wordEls[li];
    if (!tm || !words) return;
    let wi = -1;
    for (let k = 0; k < tm.times.length; k++) if (tm.times[k] <= ms) wi = k;
    const key = li * 10000 + wi;
    if (key !== wordIdx) {
      wordIdx = key;
      words.forEach((w, k) => { w.classList.toggle("d", k < wi); w.classList.toggle("cw", k === wi); if (k !== wi) w.style.removeProperty("--p"); });
    }
    if (wi >= 0) {
      const a = tm.times[wi], b = wi + 1 < tm.times.length ? tm.times[wi + 1] : tm.end;
      const frac = ms >= tm.end ? 1 : clamp((ms - a) / Math.max(80, b - a), 0, 1);
      const p = -8 + 108 * frac; // -8% = nothing lit, 100% = whole word lit
      words[wi].style.setProperty("--p", p.toFixed(1) + "%");
    }
  }

  const clock = { ms: 0 };
  function lyricClock() {
    const raw = S.Player.getProgress();
    if (S.Player.isPlaying() && raw < clock.ms && clock.ms - raw < 700) return clock.ms; // small backward jitter -> hold
    clock.ms = raw;
    return raw;
  }

  const LEAD = 120; // light up slightly before the sound, like karaoke
  const lyricTime = () => lyricClock() + LEAD + (cfg.lyrOffset || 0);
  function shiftLyrics(d) {
    cfg.lyrOffset = d === 0 ? 0 : clamp(Math.round(((cfg.lyrOffset || 0) + d) / 10) * 10, -5000, 5000);
    save();
    lyrIdx = -2; wordIdx = -2;
    const v = cfg.lyrOffset;
    osd(v === 0 ? "Текст без сдвига" : `Текст ${v > 0 ? "раньше" : "позже"} на ${(Math.abs(v) / 1000).toFixed(1)} с`);
    if (el.pop.classList.contains("show")) renderSettings();
  }

  function currentLineIndex(ms) {
    const lines = lyr.data && lyr.data.lines;
    if (!lines) return -1;
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (lines[m].t <= ms) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans;
  }

  function syncLyrics(ms, force) {
    if (lyr.status !== "ok" || !lyr.data.synced || !lineEls.length) return;
    const idx = currentLineIndex(ms + 180);
    if (idx >= 0) syncWords(ms, idx);
    if (idx === lyrIdx && !force) return;
    if (lyrIdx >= 0 && wordEls[lyrIdx]) wordEls[lyrIdx].forEach((w) => { w.classList.remove("d", "cw"); w.style.removeProperty("--p"); });
    wordIdx = -2;
    if (idx >= 0) syncWords(ms, idx);
    lyrIdx = idx;
    lineEls.forEach((e, i) => {
      e.classList.toggle("on", i === idx);
      e.classList.toggle("past", i < idx);
      e.classList.toggle("far", Math.abs(i - idx) > 3);
    });
    const target = lineEls[Math.max(0, idx)];
    const y = target.offsetTop + target.offsetHeight / 2 - el.lyrics.clientHeight * 0.4;
    el.lyrInner.style.transform = `translateY(${-y}px)`; // may be positive: first lines sit at the reading line, not under the top fade
  }

  function applyView() {
    const want = cfg.view === "lyrics";
    root.classList.toggle("lyr", want && lyr.status !== "none");
    topBtn("lyrics").classList.toggle("on", want);
    el.lyrbtn.classList.toggle("on", want);
  }
  function setView(v, announce) {
    cfg.view = v;
    save();
    applyView();
    if (announce) osd(v === "lyrics" ? (lyr.status === "none" ? "Текст включён — у этого трека его нет" : "Текст включён") : "Текст выключен");
    setTimeout(() => syncLyrics(S.Player.getProgress(), true), 520);
  }
  const toggleLyrics = () => setView(cfg.view === "lyrics" ? "cover" : "lyrics", true);

  // ================= queue =================
  function renderQueue() {
    const list = nextTracks().slice(0, 60);
    const sig = list.map((t) => t.contextTrack.uid || t.contextTrack.uri).join("|");
    if (sig === queueSig) return;
    queueSig = sig;
    const api = S.Platform && S.Platform.PlayerAPI;
    const canSkip = !!(api && api.skipTo);
    if (!list.length) { el.qlist.innerHTML = `<div class="v-qempty">Дальше ничего нет</div>`; return; }
    let html = "", lastSec = "";
    list.forEach((t, i) => {
      const m = t.contextTrack.metadata;
      const sec = t.provider === "queue" ? "В очереди" : "Далее";
      if (sec !== lastSec) { html += `<div class="v-qsec">${sec}</div>`; lastSec = sec; }
      const img = imgUrl(m.image_url || m.image_small_url || "");
      const dur = +m.duration ? fmt(+m.duration) : "";
      html += `<div class="v-qi${canSkip ? " click" : ""}" data-i="${i}" title="${canSkip ? "Включить" : ""}">
        ${img ? `<img src="${esc(img)}" loading="lazy">` : `<div class="ph"></div>`}
        <div style="min-width:0"><div class="v-qt">${esc(m.title)}</div><div class="v-qa">${esc(m.artist_name || "")}</div></div>
        <div class="v-qd">${dur}</div></div>`;
    });
    el.qlist.innerHTML = html;
    el.qlist.onclick = (e) => {
      const it = e.target.closest(".v-qi.click");
      if (!it) return;
      const t = list[+it.dataset.i];
      try { api.skipTo({ uri: t.contextTrack.uri, uid: t.contextTrack.uid }); } catch (err) { osd("Не получилось переключить"); }
    };
  }
  function toggleQueue(force) {
    const on = force ?? !root.classList.contains("q");
    root.classList.toggle("q", on);
    topBtn("queue").classList.toggle("on", on);
    if (on) { queueSig = ""; renderQueue(); }
    setTimeout(() => syncLyrics(S.Player.getProgress(), true), 400);
  }

  // ================= settings =================
  function renderSettings() {
    const sw = (key, label, hint) =>
      `<div class="v-row"><div>${label}${hint ? `<small>${hint}</small>` : ""}</div><button class="v-sw${cfg[key] ? " on" : ""}" data-k="${key}"></button></div>`;
    const seg = (name, opts, curVal) =>
      `<div class="v-seg" data-seg="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(curVal) ? "on" : ""}">${l}</button>`).join("")}</div>`;
    const sleepVal = sleep.track ? "track" : sleep.until ? "active" : 0;
    el.pop.innerHTML = `<h3>Настройки</h3>
      ${sw("viz", "Визуализатор вокруг обложки", !cfg.viz ? "" : vizReal() ? "Источник: реальный звук (volna-audio)" : "Источник: анализ трека. Для реального звука нужен помощник volna-audio")}
      ${cfg.viz ? `<div class="v-row col"><div>Стиль визуализатора<small>Клавиша V — следующий стиль</small></div>${seg("vizStyle", VIZ_STYLES, cfg.vizStyle)}</div>` : ""}
      ${sw("pulse", "Пульсация в такт", "Обложка и фон дышат по битам трека")}
      ${sw("liveBg", "Живой фон", "Фон медленно плывёт")}
      ${sw("tilt", "3D-наклон обложки", "Обложка следует за мышью")}
      ${sw("remaining", "Показывать оставшееся время")}
      <div class="v-row col"><div>Сдвиг текста: ${cfg.lyrOffset ? `${cfg.lyrOffset > 0 ? "раньше" : "позже"} на ${(Math.abs(cfg.lyrOffset) / 1000).toFixed(1)} с` : "нет"}<small>Если текст отстаёт — жми «раньше». Клавиши [ и ]</small></div>
        <div class="v-seg" data-seg="offset"><button data-v="-500">−0.5 с</button><button data-v="-100">−0.1 с</button><button data-v="100">+0.1 с</button><button data-v="500">+0.5 с</button><button data-v="0" class="${cfg.lyrOffset ? "" : "on"}">Сброс</button></div></div>
      ${sw("lrclib", "Искать текст на LRCLIB", "Если у Spotify текста нет. Отправляет название трека на lrclib.net")}
      <div class="v-row col"><div>Открывать «Волну» при простое<small>Если музыка играет, а ты ничего не трогаешь</small></div>
        ${seg("idle", [[0, "Выкл"], [1, "1 мин"], [3, "3 мин"], [5, "5 мин"], [10, "10 мин"]], cfg.idleOpen)}</div>
      <div class="v-row col"><div>Таймер сна${sleep.until ? `<small>Пауза в ${new Date(sleep.until).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}</small>` : sleep.track ? "<small>Пауза после этого трека</small>" : ""}</div>
        ${seg("sleep", [[0, "Выкл"], [15, "15 мин"], [30, "30 мин"], [60, "1 час"], ["track", "После трека"]], sleepVal)}</div>`;
  }
  el.pop.addEventListener("click", (e) => {
    const s = e.target.closest(".v-sw");
    if (s) {
      const k = s.dataset.k;
      cfg[k] = !cfg[k];
      save();
      applyCfg();
      if (k === "lrclib" && cfg.lrclib && cur && lyr.status === "none") { LYR.delete(cur.uri); DB.del("l:" + cur.uri); loadLyrics(cur); }
      renderSettings();
      return;
    }
    const b = e.target.closest(".v-seg button");
    if (!b) return;
    const name = b.parentElement.dataset.seg, v = b.dataset.v;
    if (name === "idle") { cfg.idleOpen = +v; save(); }
    if (name === "offset") { shiftLyrics(+v); return; }
    if (name === "vizStyle") { cfg.vizStyle = v; save(); }
    if (name === "sleep") setSleep(v === "track" ? "track" : +v);
    renderSettings();
  });
  function toggleSettings(force) {
    const on = force ?? !el.pop.classList.contains("show");
    if (on) renderSettings();
    el.pop.classList.toggle("show", on);
    topBtn("settings").classList.toggle("on", on);
  }
  function toggleHelp(force) {
    const on = force ?? !el.help.classList.contains("show");
    el.help.classList.toggle("show", on);
    topBtn("help").classList.toggle("on", on);
  }
  el.help.addEventListener("click", (e) => { if (e.target === el.help) toggleHelp(false); });

  function applyCfg() {
    root.classList.toggle("vizon", !!cfg.viz);
    if (!cfg.viz) {
      vizDisconnect();
      el.cover.style.boxShadow = "";
      const ctx = el.viz.getContext("2d");
      ctx.clearRect(0, 0, el.viz.width, el.viz.height);
    }
    root.classList.toggle("live", !!cfg.liveBg);
    if (!cfg.tilt) tilt = { x: 0, y: 0 };
  }

  // ================= sleep timer =================
  function setSleep(v) {
    sleep = { until: 0, track: false };
    if (v === "track") { sleep.track = true; osd("Пауза после этого трека"); }
    else if (v > 0) { sleep.until = Date.now() + v * 60000; osd(`Таймер сна: ${v} мин`); }
    else osd("Таймер сна выключен");
    updateChip();
  }
  function updateChip() {
    const on = !!(sleep.until || sleep.track);
    el.chip.classList.toggle("show", on);
    if (sleep.track) el.chipText.textContent = "после трека";
    else if (sleep.until) el.chipText.textContent = fmt(sleep.until - Date.now());
  }
  el.chip.onclick = () => { setSleep(0); if (el.pop.classList.contains("show")) renderSettings(); };

  // ================= visualizer around the cover =================
  // Real spectrum comes from the local helper (volna-audio.py, reads the PipeWire monitor of the
  // default output). Without it, a synced approximation is built from Spotify's audio analysis.
  const VIZ_URL = "http://127.0.0.1:47823/stream";
  const viz = { es: null, lastMsg: 0, retryAt: 0, raw: new Float32Array(65), bands: new Float32Array(64), bass: 0,
    bassAvg: 0.3, bassMax: 0.5, agc: 0.5, segIdx: 0, accent: "255,255,255", rgb: [120, 120, 130], parts: [], lastT: 0,
    trail: [new Float32Array(64), new Float32Array(64), new Float32Array(64)] };
  const vizReal = () => !!viz.es && performance.now() - viz.lastMsg < 600;
  function vizSetColor(rgb) { viz.rgb = rgb; viz.accent = rgb.map((v) => Math.round(v + (255 - v) * 0.45)).join(","); }
  function vizConnect() {
    if (!cfg.viz || viz.es || Date.now() < viz.retryAt || typeof EventSource === "undefined") return;
    viz.retryAt = Date.now() + 8000;
    try {
      const es = new EventSource(VIZ_URL);
      viz.es = es;
      es.onmessage = (e) => {
        const h = e.data;
        if (h.length < 130) return;
        for (let i = 0; i < 65; i++) viz.raw[i] = parseInt(h.substr(i * 2, 2), 16) / 255;
        viz.lastMsg = performance.now();
      };
      es.onerror = () => { es.close(); if (viz.es === es) viz.es = null; };
    } catch (e) { viz.es = null; }
  }
  function vizDisconnect() { if (viz.es) viz.es.close(); viz.es = null; }

  function vizSynthetic(ms, pulse) {
    const sg = audio.segs;
    if (!sg || !sg.length || !S.Player.isPlaying()) { viz.raw.fill(0); return; }
    let i = viz.segIdx;
    if (i >= sg.length || sg[i].s > ms) i = 0;
    while (i + 1 < sg.length && sg[i + 1].s <= ms) i++;
    viz.segIdx = i;
    const g = sg[i], nx = sg[i + 1], local = ms - g.s;
    let db;
    if (local < g.lt) db = g.l0 + (g.lm - g.l0) * (local / Math.max(1, g.lt));
    else db = g.lm + ((nx ? nx.l0 : -60) - g.lm) * Math.min(1, (local - g.lt) / Math.max(1, g.d - g.lt));
    const level = clamp((db - audio.vlo) / (audio.vhi - audio.vlo), 0, 1);
    const bright = clamp((((g.tb && g.tb[1]) || 0) + 60) / 160, 0, 1);
    for (let b = 0; b < 64; b++) {
      const f = b / 63;
      let v;
      if (f < 0.2) v = level * (0.5 + 0.5 * pulse) * (1 - f * 1.2);
      else {
        const pc = g.p ? g.p[(b * 7) % 12] : 0.5;
        v = level * (0.3 + 0.7 * pc) * (f < 0.6 ? 0.85 : 0.35 + 0.65 * bright) * (1 - f * 0.4);
      }
      viz.raw[b] = v;
    }
    viz.raw[64] = level * (0.3 + 0.7 * pulse);
  }

  function vizUpdate() {
    let mx = 0;
    for (let b = 0; b < 64; b++) mx = Math.max(mx, viz.raw[b]);
    viz.agc = Math.max(mx, viz.agc * 0.997, 0.2);
    const floor = viz.agc * 0.38, span = viz.agc - floor;
    for (let b = 0; b < 64; b++) {
      const t = Math.pow(clamp((viz.raw[b] - floor) / span, 0, 1), 1.3);
      viz.bands[b] += (t - viz.bands[b]) * (t > viz.bands[b] ? 0.7 : 0.22);
    }
    // bass "kick": how far the bass jumps above its own recent average
    const rb = viz.raw[64];
    viz.bassAvg += (rb - viz.bassAvg) * 0.02;
    viz.bassMax = Math.max(rb, viz.bassMax * 0.996, viz.bassAvg + 0.08);
    const base = viz.bassAvg * 0.9;
    const kick = clamp((rb - base) / Math.max(0.06, viz.bassMax - base), 0, 1);
    viz.bass += (kick - viz.bass) * (kick > viz.bass ? 0.6 : 0.14);
  }

  // rounded-square path around the cover, walked from bottom-centre; returns point + outward normal
  function perimeter(x0, y0, w, r) {
    const x1 = x0 + w, y1 = y0 + w, L = w - 2 * r, A = (Math.PI * r) / 2, cx = x0 + w / 2;
    const segs = [
      { len: L / 2, at: (d) => [cx - d, y1, 0, 1] },
      { len: A, at: (d) => { const a = Math.PI / 2 + d / r; return [x0 + r + r * Math.cos(a), y1 - r + r * Math.sin(a), Math.cos(a), Math.sin(a)]; } },
      { len: L, at: (d) => [x0, y1 - r - d, -1, 0] },
      { len: A, at: (d) => { const a = Math.PI + d / r; return [x0 + r + r * Math.cos(a), y0 + r + r * Math.sin(a), Math.cos(a), Math.sin(a)]; } },
      { len: L, at: (d) => [x0 + r + d, y0, 0, -1] },
      { len: A, at: (d) => { const a = 1.5 * Math.PI + d / r; return [x1 - r + r * Math.cos(a), y0 + r + r * Math.sin(a), Math.cos(a), Math.sin(a)]; } },
      { len: L, at: (d) => [x1, y0 + r + d, 1, 0] },
      { len: A, at: (d) => { const a = d / r; return [x1 - r + r * Math.cos(a), y1 - r + r * Math.sin(a), Math.cos(a), Math.sin(a)]; } },
      { len: L / 2, at: (d) => [x1 - r - d, y1, 0, 1] },
    ];
    const total = segs.reduce((a, g) => a + g.len, 0);
    return { total, at(d) { for (const g of segs) { if (d <= g.len) return g.at(d); d -= g.len; } return segs[0].at(0); } };
  }

  const VIZ_STYLES = [["bars", "Лучи"], ["bass", "Басы"]];

  // spectrum sampled around the ring: bass at bottom-centre, highs at top-centre (mirrored)
  function sampleRing(src, M, smooth) {
    let out = new Float32Array(M);
    for (let k = 0; k < M; k++) {
      const sp = (k + 0.5) / M;
      const m = sp <= 0.5 ? sp * 2 : (1 - sp) * 2;
      const fb = m * 63, i0 = Math.floor(fb);
      out[k] = src[i0] + (src[Math.min(63, i0 + 1)] - src[i0]) * (fb - i0);
    }
    for (let pass = 0; pass < 2 && smooth > 0; pass++) {
      const tmp = new Float32Array(M);
      for (let k = 0; k < M; k++) {
        let acc = 0;
        for (let j = -smooth; j <= smooth; j++) acc += out[(k + j + M) % M];
        tmp[k] = acc / (2 * smooth + 1);
      }
      out = tmp;
    }
    return out;
  }
  function ringPoints(per, vals, base, amp, pow = 1) {
    const M = vals.length, pts = new Array(M);
    for (let k = 0; k < M; k++) {
      const [x, y, nx, ny] = per.at(((k + 0.5) / M) * per.total);
      const off = base + amp * Math.pow(vals[k], pow);
      pts[k] = [x + nx * off, y + ny * off];
    }
    return pts;
  }
  function smoothPath(ctx, pts) {
    const n = pts.length;
    ctx.beginPath();
    const p0 = pts[n - 1], p1 = pts[0];
    ctx.moveTo((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
    for (let i = 0; i < n; i++) {
      const q = pts[i], r = pts[(i + 1) % n];
      ctx.quadraticCurveTo(q[0], q[1], (q[0] + r[0]) / 2, (q[1] + r[1]) / 2);
    }
    ctx.closePath();
  }
  const mix = (rgb, w, k) => rgb.map((v, i) => Math.round(v + (w[i] - v) * k)).join(",");

  function vizDraw() {
    const c = el.viz;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const now = performance.now();
    const dt = clamp((now - (viz.lastT || now)) / 16.7, 0.3, 3);
    viz.lastT = now;
    const cr = el.cover.getBoundingClientRect(), rr = root.getBoundingClientRect();
    const size = cr.width, ox = cr.left - rr.left, oy = cr.top - rr.top;
    if (!size) return;
    const gap = size * 0.03;
    const per = perimeter(ox - gap, oy - gap, size + gap * 2, size * 0.1 + gap);
    const small = root.classList.contains("lyr") ? 0.5 : 1;
    const B = viz.bass, A = viz.accent;

    if (cfg.vizStyle === "bass") {
      // layered silhouettes: outer layers hold their peaks longer -> trailing burst
      const decays = [0.03, 0.017, 0.009];
      viz.trail.forEach((tr, L) => { for (let b = 0; b < 64; b++) tr[b] = Math.max(viz.bands[b], tr[b] - decays[L] * dt); });
      const W3 = [255, 255, 255];
      const layers = [
        { src: viz.trail[2], base: 0.03, amp: 0.58, col: mix(viz.rgb, W3, 0.1), a: 0.55, glow: true },
        { src: viz.trail[1], base: 0.024, amp: 0.44, col: mix(viz.rgb, W3, 0.35), a: 0.75 },
        { src: viz.trail[0], base: 0.016, amp: 0.3, col: mix(viz.rgb, W3, 0.65), a: 0.9 },
        { src: viz.bands, base: 0.004, amp: 0.1, col: "255,255,255", a: 0.95 },
      ];
      for (const L of layers) {
        const pts = ringPoints(per, sampleRing(L.src, 96, 0), size * L.base, size * L.amp * small * (0.7 + 0.6 * B), 1.1);
        ctx.save();
        if (L.glow) { ctx.shadowBlur = size * 0.08; ctx.shadowColor = `rgba(${A},.9)`; }
        ctx.fillStyle = `rgba(${L.col},${L.a})`;
        smoothPath(ctx, pts);
        ctx.fill();
        ctx.restore();
      }
      // drifting sparkles, more on every kick
      const emit = Math.min(12, Math.floor(B * B * 9 * dt + Math.random() * 0.6));
      for (let e = 0; e < emit && viz.parts.length < 260; e++) {
        const sp = Math.random(), [x, y, nx, ny] = per.at(sp * per.total), sp0 = size * (0.002 + 0.006 * B + Math.random() * 0.003);
        const j = (Math.random() - 0.5) * 0.8;
        viz.parts.push({ x: x + nx * size * 0.05, y: y + ny * size * 0.05, vx: (nx - ny * j) * sp0, vy: (ny + nx * j) * sp0, life: 1, decay: 0.005 + Math.random() * 0.008, r: 0.7 + Math.random() * 1.8 });
      }
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      viz.parts = viz.parts.filter((p) => {
        p.x += p.vx * dt; p.y += p.vy * dt; p.life -= p.decay * dt;
        if (p.life <= 0) return false;
        ctx.fillStyle = `rgba(255,255,255,${(p.life * 0.85).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        return true;
      });
      ctx.restore();
    } else {
      // rays: long, unsmoothed, kicked hard by the bass
      if (viz.parts.length) viz.parts = [];
      const N = 120;
      const vals = sampleRing(viz.bands, N, 0);
      const maxLen = size * 0.36 * small, minLen = size * 0.008;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1.8, (per.total / N) * 0.34);
      ctx.shadowBlur = 8 + B * 18;
      ctx.shadowColor = `rgba(${A},.9)`;
      ctx.strokeStyle = `rgba(255,255,255,${(0.78 + B * 0.22).toFixed(3)})`;
      ctx.beginPath();
      for (let k = 0; k < N; k++) {
        const [x, y, nx, ny] = per.at(((k + 0.5) / N) * per.total);
        const len = minLen + maxLen * Math.pow(vals[k], 1.15) * (0.7 + 0.8 * B);
        ctx.moveTo(x, y);
        ctx.lineTo(x + nx * len, y + ny * len);
      }
      ctx.stroke();
    }

  }

  function cycleVizStyle() {
    if (!cfg.viz) { cfg.viz = true; applyCfg(); }
    const i = VIZ_STYLES.findIndex(([k]) => k === cfg.vizStyle);
    const [k, label] = VIZ_STYLES[(i + 1) % VIZ_STYLES.length];
    cfg.vizStyle = k;
    save();
    osd(`Визуализатор: ${label}`);
    if (el.pop.classList.contains("show")) renderSettings();
  }

  // ================= waveform + animation loop =================
  function findBeat(t) {
    const b = audio.beats;
    if (!b.length) return null;
    if (beatIdx >= b.length || b[beatIdx].start > t) beatIdx = 0;
    while (beatIdx + 1 < b.length && b[beatIdx + 1].start <= t) beatIdx++;
    return b[beatIdx].start <= t ? b[beatIdx] : null;
  }

  function draw() {
    const c = el.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    const progress = S.Player.getProgress();
    const dur = S.Player.getDuration() || 1;

    // beat pulse + tilt on the cover
    let pulse = 0;
    if (cfg.pulse && audio.beats.length && S.Player.isPlaying()) {
      const t = progress / 1000;
      const b = findBeat(t);
      if (b) {
        const ph = (t - b.start) / Math.max(0.25, b.duration);
        const energy = audio.peaks[Math.min(audio.peaks.length - 1, Math.floor((progress / dur) * audio.peaks.length))] || 0.5;
        pulse = Math.exp(-ph * 4.5) * (0.35 + 0.65 * Math.min(1, b.confidence * 1.6)) * energy;
      }
    }
    const idle = root.classList.contains("idle");
    const tx = cfg.tilt && !idle ? (mouse.x - 0.5) * 9 : 0;
    const ty = cfg.tilt && !idle ? -(mouse.y - 0.5) * 7 : 0;
    tilt.x += (tx - tilt.x) * 0.08;
    tilt.y += (ty - tilt.y) * 0.08;
    let scale = 1 + pulse * 0.028, bgScale = 1 + pulse * 0.045;
    if (cfg.viz) {
      vizConnect();
      if (!vizReal()) vizSynthetic(progress, pulse);
      vizUpdate();
      vizDraw();
      scale = 1 + viz.bass * 0.045;
      bgScale = 1 + viz.bass * 0.06;
      const g = 1;
      el.cover.style.boxShadow = `0 30px 80px rgba(0,0,0,.45), 0 0 ${((30 + viz.bass * 110) * g).toFixed(0)}px ${(viz.bass * 26 * g).toFixed(0)}px rgba(${viz.accent},${Math.min(0.9, (0.12 + viz.bass * 0.5) * g).toFixed(3)})`;
    }
    el.cover.style.transform = `perspective(1000px) rotateX(${tilt.y.toFixed(2)}deg) rotateY(${tilt.x.toFixed(2)}deg) scale(${scale.toFixed(4)})`;
    el.bgwrap.style.transform = `scale(${bgScale.toFixed(4)})`;

    if (root.classList.contains("lyr")) syncLyrics(lyricTime());

    el.cur.textContent = fmt(progress);
    el.dur.textContent = cfg.remaining ? "−" + fmt(dur - progress) : fmt(dur);

    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const prog = clamp(progress / dur, 0, 1);
    const barW = 3, gap = 2;
    const n = Math.max(20, Math.floor((w + gap) / (barW + gap)));
    const playedX = prog * w;
    const target = audio.peaks;
    if (shownPeaks.length !== target.length) shownPeaks = Float32Array.from(target);
    for (let k = 0; k < target.length; k++) shownPeaks[k] += (target[k] - shownPeaks[k]) * 0.12;
    const peaks = shownPeaks;
    for (let i = 0; i < n; i++) {
      const p0 = Math.floor((i / n) * peaks.length);
      const p1 = Math.max(p0 + 1, Math.floor(((i + 1) / n) * peaks.length));
      let v = 0;
      for (let k = p0; k < p1; k++) v = Math.max(v, peaks[k] || 0);
      const bh = Math.max(3, v * h);
      const x = i * (barW + gap);
      if (x + barW <= playedX) ctx.fillStyle = "rgba(255,255,255,0.95)";
      else if (hoverX >= 0 && x <= hoverX && x >= playedX) ctx.fillStyle = "rgba(255,255,255,0.6)";
      else ctx.fillStyle = "rgba(255,255,255,0.32)";
      ctx.fillRect(x, (h - bh) / 2, barW, bh);
    }
  }

  function loop() {
    stepColor();
    draw();
    raf = requestAnimationFrame(loop);
  }

  // ================= open/close =================
  function open() {
    if (isOpen) return;
    isOpen = true;
    cur = null;
    applyCfg();
    setView(cfg.view);
    updateTrack();
    root.classList.add("open");
    setTimeout(() => { if (isOpen) document.documentElement.classList.add("volna-under"); }, 400);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    poke();
    if (cfg.hints < 3) { cfg.hints++; save(); setTimeout(() => osd("H — горячие клавиши", 3500), 700); }
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    document.documentElement.classList.remove("volna-under");
    root.classList.remove("open", "idle");
    vizDisconnect();
    toggleSettings(false);
    toggleHelp(false);
    cancelAnimationFrame(raf);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  const toggle = () => (isOpen ? close() : open());
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  function poke() {
    root.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (isOpen && !el.pop.classList.contains("show") && !el.help.classList.contains("show") && !root.classList.contains("q")) root.classList.add("idle");
    }, 3000);
  }

  function navigate(uri) {
    if (!uri) return;
    const [, type, id] = uri.split(":");
    if (!type || !id) return;
    close();
    try { S.Platform.History.push(`/${type}/${id}`); } catch (e) {}
  }

  // ================= events =================
  root.querySelector(".v-top").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    ({
      lyrics: toggleLyrics,
      queue: () => toggleQueue(),
      pip: () => togglePip(),
      settings: () => toggleSettings(),
      help: () => toggleHelp(),
      full: toggleFullscreen,
      close,
    })[b.dataset.a]();
  });
  el.play.onclick = () => S.Player.togglePlay();
  $(".v-prev", root).onclick = () => S.Player.back();
  $(".v-next-btn", root).onclick = () => S.Player.next();
  el.shuffle.onclick = toggleShuffle;
  el.repeat.onclick = cycleRepeat;
  el.heart.onclick = toggleHeart;
  el.lyrbtn.onclick = toggleLyrics;
  el.mute.onclick = toggleMute;
  el.cover.ondblclick = toggleFullscreen;
  el.next.onclick = () => toggleQueue(true);
  el.dur.onclick = () => { cfg.remaining = !cfg.remaining; save(); };
  el.artist.addEventListener("click", (e) => { const a = e.target.closest(".v-link"); if (a) navigate(a.dataset.uri); });
  el.album.addEventListener("click", (e) => { const a = e.target.closest(".v-link"); if (a) navigate(a.dataset.uri); });
  el.lyrInner.addEventListener("click", (e) => {
    const l = e.target.closest(".v-line");
    if (!l || !lyr.data || !lyr.data.synced) return;
    const li = +l.dataset.i, w = e.target.closest(".v-w");
    const t = w && timing[li] ? timing[li].times[+w.dataset.w] : lyr.data.lines[li].t;
    S.Player.seek(Math.max(0, Math.round(t) - LEAD - (cfg.lyrOffset || 0) + 20));
    lyrIdx = -2; clock.ms = 0;
  });

  // volume slider (click + drag)
  const volFromEvent = (e) => { const r = el.volhit.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  el.volhit.addEventListener("mousedown", (e) => {
    setVolume(volFromEvent(e));
    const mv = (ev) => setVolume(volFromEvent(ev));
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  });
  root.addEventListener("wheel", (e) => {
    if (e.target.closest(".v-lyrics.unsynced, .v-queue, .v-pop, .v-help")) return;
    e.preventDefault();
    setVolume(volume() + (e.deltaY < 0 ? 0.05 : -0.05));
    poke();
  }, { passive: false });

  root.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX / window.innerWidth;
    mouse.y = e.clientY / window.innerHeight;
    poke();
  });
  root.addEventListener("mousedown", (e) => {
    if (el.pop.classList.contains("show") && !e.target.closest(".v-pop, .v-top")) toggleSettings(false);
  });

  el.wave.addEventListener("mousemove", (e) => {
    const r = el.wave.getBoundingClientRect();
    hoverX = clamp(e.clientX - r.left, 0, r.width);
    el.tip.style.left = hoverX + "px";
    el.tip.textContent = fmt((hoverX / r.width) * S.Player.getDuration());
  });
  el.wave.addEventListener("mouseleave", () => (hoverX = -1));
  el.wave.addEventListener("click", (e) => {
    const r = el.wave.getBoundingClientRect();
    S.Player.seek(Math.round(((e.clientX - r.left) / r.width) * S.Player.getDuration()));
    lyrIdx = -2; clock.ms = 0;
  });

  // shared keyboard handling (main window + mini player)
  function handleKey(e, inPip) {
    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.code) {
      case "Space": S.Player.togglePlay(); break;
      case "ArrowRight": ctrl ? S.Player.next() : S.Player.seek(S.Player.getProgress() + 5000); lyrIdx = -2; clock.ms = 0; break;
      case "ArrowLeft": ctrl ? S.Player.back() : S.Player.seek(Math.max(0, S.Player.getProgress() - 5000)); lyrIdx = -2; clock.ms = 0; break;
      case "ArrowUp": setVolume(volume() + 0.05); break;
      case "ArrowDown": setVolume(volume() - 0.05); break;
      case "KeyM": toggleMute(); break;
      case "KeyL": toggleHeart(); break;
      case "KeyS": toggleShuffle(); break;
      case "KeyR": cycleRepeat(); break;
      case "KeyP": togglePip(); break;
      case "KeyV": if (inPip || ctrl || e.shiftKey) return false; cycleVizStyle(); break;
      case "BracketRight": shiftLyrics(100); break;
      case "BracketLeft": shiftLyrics(-100); break;
      default:
        if (inPip) return false;
        switch (e.code) {
          case "KeyF": toggleFullscreen(); break;
          case "KeyT": toggleLyrics(); break;
          case "KeyQ": toggleQueue(); break;
          case "KeyH": toggleHelp(); break;
          case "Slash": if (!e.shiftKey) return false; toggleHelp(); break;
          case "Comma": toggleSettings(); break;
          case "Escape":
            if (el.help.classList.contains("show")) toggleHelp(false);
            else if (el.pop.classList.contains("show")) toggleSettings(false);
            else if (root.classList.contains("q")) toggleQueue(false);
            else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
            else close();
            break;
          default: return false;
        }
    }
    return true;
  }

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
      e.preventDefault();
      e.stopPropagation();
      toggle();
      return;
    }
    if (!isOpen) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
    if (e.altKey) return;
    if (handleKey(e, false)) { e.preventDefault(); e.stopPropagation(); poke(); }
  }, true);

  // ================= mini player (Document Picture-in-Picture, always on top) =================
  let pip = null;
  const PIP_CSS = `
  ${FONT_IMPORT}
  *{box-sizing:border-box;margin:0}
  html{--c:40,40,48}
  html,body{height:100%;background:rgb(var(--c));color:#fff;font-family:"SpotifyMixUI",system-ui,sans-serif;overflow:hidden;user-select:none}
  .bg{position:fixed;inset:-25%;background:center/cover;filter:blur(40px) saturate(1.6) brightness(.9);opacity:.85;transition:background-image .6s}
  .tint{position:fixed;inset:0;background:linear-gradient(rgba(var(--c),.4),rgba(var(--c),.7) 55%,rgba(0,0,0,.6))}
  .main{position:relative;height:100%;display:flex;flex-direction:column;padding:16px;gap:12px}
  .cover{width:min(100%,calc(100vh - 196px));aspect-ratio:1;align-self:center;border-radius:10px;background:rgba(0,0,0,.2) center/cover;box-shadow:0 14px 40px rgba(0,0,0,.4);flex:none}
  .info{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1;justify-content:flex-end}
  .title{font:800 18px/1.15 ${TITLE_FONT};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .artist{font-size:13px;color:rgba(255,255,255,.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .line{font-size:13px;font-weight:700;min-height:1.3em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .3s}
  .bar{height:14px;display:flex;align-items:center;cursor:pointer;margin-top:2px}
  .bar>div{height:4px;border-radius:2px;background:rgba(255,255,255,.28);flex:1;position:relative;overflow:hidden}
  .bar i{position:absolute;left:0;top:0;bottom:0;background:#fff}
  .times{display:flex;justify-content:space-between;font-size:11px;color:rgba(255,255,255,.7);margin-top:-4px;font-variant-numeric:tabular-nums}
  .ctl{display:flex;justify-content:center;align-items:center;gap:14px}
  button{all:unset;cursor:pointer;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;color:rgba(255,255,255,.8);transition:transform .15s,color .15s}
  button:hover{color:#fff;transform:scale(1.08)}
  button svg{width:18px;height:18px;fill:currentColor}
  .play{width:46px;height:46px;background:#fff;color:#111}
  .play:hover{color:#000}
  .liked{color:#1ed760}
  .osd{position:fixed;top:10px;left:50%;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:rgba(0,0,0,.5);font-size:12px;font-weight:600;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}
  .osd.show{opacity:1}
  @media (min-aspect-ratio:7/5){
    .main{flex-direction:row;align-items:center}
    .cover{width:auto;height:calc(100vh - 32px);max-width:45%}
    .info{height:100%;justify-content:center}
  }
  @media (max-height:150px){ .line,.times{display:none} }`;

  async function togglePip() {
    if (pip) { pip.win.close(); return; }
    const D = window.documentPictureInPicture;
    if (!D) { osd("Мини-плеер не поддерживается этой версией Spotify"); return; }
    let win;
    try { win = await D.requestWindow({ width: 340, height: 440 }); }
    catch (e) { osd("Не удалось открыть мини-плеер"); return; }
    const doc = win.document;
    doc.title = "Волна";
    const st = doc.createElement("style");
    st.textContent = PIP_CSS;
    doc.head.appendChild(st);
    doc.body.innerHTML = `<div class="bg"></div><div class="tint"></div><div class="osd"></div>
      <div class="main"><div class="cover"></div><div class="info">
        <div class="title"></div><div class="artist"></div><div class="line"></div>
        <div class="bar"><div><i></i></div></div><div class="times"><span class="c">0:00</span><span class="d">0:00</span></div>
        <div class="ctl"><button class="sh">${I.shuffle}</button><button class="pr">${I.prev}</button><button class="play">${I.pause}</button><button class="nx">${I.next}</button><button class="hr">${I.heart}</button></div>
      </div></div>`;
    const q = (s) => doc.querySelector(s);
    pip = {
      win, doc, osdTimer: 0,
      el: { bg: q(".bg"), cover: q(".cover"), title: q(".title"), artist: q(".artist"), line: q(".line"), bar: q(".bar"), fill: q(".bar i"),
            c: q(".c"), d: q(".d"), play: q(".play"), sh: q(".sh"), hr: q(".hr"), osd: q(".osd") },
    };
    const p = pip;
    p.el.play.onclick = () => S.Player.togglePlay();
    q(".pr").onclick = () => S.Player.back();
    q(".nx").onclick = () => S.Player.next();
    p.el.sh.onclick = toggleShuffle;
    p.el.hr.onclick = toggleHeart;
    p.el.bar.onclick = (e) => {
      const r = p.el.bar.getBoundingClientRect();
      S.Player.seek(Math.round(((e.clientX - r.left) / r.width) * S.Player.getDuration()));
    };
    doc.addEventListener("wheel", (e) => { e.preventDefault(); setVolume(volume() + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });
    doc.addEventListener("keydown", (e) => { if (handleKey(e, true)) e.preventDefault(); });
    win.addEventListener("pagehide", () => { if (pip === p) pip = null; topBtn("pip").classList.remove("on"); });
    topBtn("pip").classList.add("on");
    if (cur) doc.documentElement.style.setProperty("--c", (COLOR.get(cur.uri) || [40, 40, 48]).join(","));
    pipTrack();
    const frame = () => { if (pip !== p) return; pipFrame(); win.requestAnimationFrame(frame); };
    win.requestAnimationFrame(frame);
  }

  function pipOsd(text) {
    if (!pip) return;
    pip.el.osd.textContent = text;
    pip.el.osd.classList.add("show");
    clearTimeout(pip.osdTimer);
    pip.osdTimer = setTimeout(() => pip && pip.el.osd.classList.remove("show"), 1300);
  }

  function pipTrack() {
    if (!pip) return;
    const i = cur || info();
    if (!i) return;
    pip.el.title.textContent = i.title;
    pip.el.artist.textContent = i.artists.map((a) => a.name).join(", ");
    pip.el.cover.style.backgroundImage = i.image ? `url("${i.image}")` : "";
    pip.el.bg.style.backgroundImage = i.image ? `url("${i.image}")` : "";
    pip.el.line.textContent = "";
    pip.lineIdx = -2;
    pipButtons();
  }

  function pipButtons() {
    if (!pip) return;
    pip.el.play.innerHTML = S.Player.isPlaying() ? I.pause : I.play;
    let v = false;
    try { v = S.Player.getShuffle(); } catch (e) {}
    pip.el.sh.style.color = v ? "#fff" : "";
    let liked = false;
    try { liked = S.Player.getHeart(); } catch (e) {}
    pip.el.hr.classList.toggle("liked", !!liked);
    pip.el.hr.innerHTML = liked ? I.heartFill : I.heart;
  }

  function pipFrame() {
    const progress = S.Player.getProgress(), dur = S.Player.getDuration() || 1;
    pip.el.fill.style.width = (clamp(progress / dur, 0, 1) * 100).toFixed(2) + "%";
    pip.el.c.textContent = fmt(progress);
    pip.el.d.textContent = cfg.remaining ? "−" + fmt(dur - progress) : fmt(dur);
    if (lyr.status === "ok" && lyr.data.synced && cur && lyr.uri === cur.uri) {
      const idx = currentLineIndex(progress + 300 + (cfg.lyrOffset || 0));
      if (idx !== pip.lineIdx) {
        pip.lineIdx = idx;
        pip.el.line.textContent = idx >= 0 ? lyr.data.lines[idx].text || "♪" : "";
      }
    }
  }

  // ================= Spotify events / timers =================
  S.Player.addEventListener("songchange", () => {
    if (sleep.track) {
      sleep.track = false;
      S.Player.pause();
      updateChip();
      osd("Таймер сна: пауза");
    }
    if (isOpen || pip) updateTrack();
  });
  S.Player.addEventListener("onplaypause", () => { if (isOpen || pip) updateButtons(); });

  ["mousemove", "keydown", "wheel", "mousedown"].forEach((ev) => window.addEventListener(ev, () => (lastActivity = Date.now()), { capture: true, passive: true }));

  setInterval(() => {
    // sleep timer
    if (sleep.until) {
      if (Date.now() >= sleep.until) {
        sleep.until = 0;
        if (S.Player.isPlaying()) S.Player.pause();
        osd("Таймер сна: пауза");
      }
      updateChip();
    }
    // auto-open when idle
    if (!isOpen && cfg.idleOpen && S.Player.isPlaying() && !document.hidden && Date.now() - lastActivity > cfg.idleOpen * 60000) open();
  }, 1000);

  setInterval(() => { if (isOpen || pip) { updateNext(); updateButtons(); } }, 2000);
  window.addEventListener("resize", () => (lyrIdx = -2));

  // ================= entry points =================
  new S.Topbar.Button("Волна (Ctrl+Shift+V)", I.wave, toggle, false);
  try { if (S.Playbar && S.Playbar.Button) new S.Playbar.Button("Волна (Ctrl+Shift+V)", I.wave, toggle, false, false); } catch (e) {}

  window.Volna = { open, close, toggle, togglePip, setView, toggleQueue, cfg, viz, _update: updateTrack };
})();
