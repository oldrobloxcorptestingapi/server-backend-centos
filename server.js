/**
 * CentOS Web — Proxy Backend  (server.js)
 * ─────────────────────────────────────────
 * Enhanced with:
 *   • Full audio/video proxying with range-request seeking
 *   • YouTube: Invidious API (no bot detection, no API key, works on Vercel)
 *   • Twitch: live stream + VOD via GQL API + HLS.js player
 *   • Complete navigation containment (no leaks)
 *
 * No special packages needed beyond express/axios/cors/cheerio.
 * Vercel-compatible: exports `app` as the default export.
 */

const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const cheerio  = require('cheerio');
const https    = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS','HEAD'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ─── Security headers to strip from every upstream response ──────────────────
const BLOCKED_HEADERS = [
  'x-frame-options','content-security-policy','content-security-policy-report-only',
  'cross-origin-embedder-policy','cross-origin-opener-policy','cross-origin-resource-policy',
  'permissions-policy','x-content-type-options','strict-transport-security',
];
function stripAndSetCors(res) {
  BLOCKED_HEADERS.forEach(h => res.removeHeader(h));
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  res.set('Content-Security-Policy', 'frame-ancestors *');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Cross-Origin-Embedder-Policy', 'unsafe-none');
}

// ─── URL helpers ──────────────────────────────────────────────────────────────
function resolveUrl(base, rel) {
  if (!rel) return '';
  if (/^(data:|javascript:|mailto:|tel:)/.test(rel)) return rel;
  if (rel.startsWith('//')) return 'https:' + rel;
  try { return new URL(rel, base).href; } catch { return rel; }
}
function makeProxyUrl(targetUrl, host) {
  if (!targetUrl || /^(javascript:|data:|#|blob:)/.test(targetUrl)) return targetUrl;
  if (targetUrl.includes('/proxy?url=')) return targetUrl;
  return `https://${host}/proxy?url=${encodeURIComponent(targetUrl)}`;
}
function rewriteCss(css, base, host) {
  if (!css) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_, q, u) => {
    const abs = resolveUrl(base, u.trim());
    if (!abs || abs.startsWith('data:')) return `url(${q}${u}${q})`;
    return `url("${makeProxyUrl(abs, host)}")`;
  });
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Site detection helpers ───────────────────────────────────────────────────
function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/(embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch(e) {}
  return null;
}
function isYouTubeUrl(url) {
  try { const u = new URL(url); return u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be'); }
  catch { return false; }
}
function isTwitchUrl(url) {
  try { const u = new URL(url); return u.hostname.includes('twitch.tv'); }
  catch { return false; }
}

// ─── Injected JS — runs inside every proxied HTML page ────────────────────────
function injectedJs(pageUrl, host) {
  const P = 'https://' + host + '/proxy?url=';
  return `<script>
(function(){
  var P=${JSON.stringify(P)}, B=${JSON.stringify(pageUrl)};
  function safeResolve(u){
    if(!u) return null; var s=String(u);
    if(/^(javascript:|data:|blob:|#|mailto:|tel:)/.test(s)) return null;
    if(/^https?:\\/\\//.test(s)) return s;
    if(s.startsWith('//')) return 'https:'+s;
    if(B&&/^https?:\\/\\//.test(B)){ try{ return new URL(s,B).href; }catch(e){ return null; } }
    return null;
  }
  function navTo(url){
    var r=safeResolve(url); if(!r) return;
    var proxied=P+encodeURIComponent(r);
    try{ window.parent.postMessage({type:'centos-nav',url:proxied},'*'); }catch(e){}
    if(window.parent===window) window.location.href=proxied;
  }

  // Block service workers (they escape the proxy)
  if(navigator.serviceWorker){
    try{
      navigator.serviceWorker.register=function(){ return Promise.resolve(); };
      navigator.serviceWorker.getRegistrations=function(){ return Promise.resolve([]); };
    }catch(e){}
  }

  // Fetch
  var _f=window.fetch;
  window.fetch=function(r,o){
    try{
      if(typeof r==='string'&&/^https?:/.test(r)&&!r.includes('/proxy?url=')) r=P+encodeURIComponent(r);
      else if(r&&typeof r==='object'&&r.url&&/^https?:/.test(r.url)&&!r.url.includes('/proxy?url='))
        r=new Request(P+encodeURIComponent(r.url),r);
    }catch(e){}
    return _f.call(this,r,o);
  };

  // XHR
  var _x=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    try{ if(typeof u==='string'&&/^https?:/.test(u)&&!u.includes('/proxy?url=')) u=P+encodeURIComponent(u); }catch(e){}
    return _x.apply(this,arguments);
  };

  // EventSource (SSE)
  if(window.EventSource){
    var _ES=window.EventSource;
    window.EventSource=function(url,cfg){
      if(typeof url==='string'&&/^https?:/.test(url)&&!url.includes('/proxy?url=')) url=P+encodeURIComponent(url);
      return new _ES(url,cfg);
    };
    window.EventSource.prototype=_ES.prototype;
  }

  // window.open
  var _open=window.open;
  window.open=function(url,target,features){
    if(url&&typeof url==='string'&&!/^(javascript:|data:|#|blob:)/.test(url)){
      var r=safeResolve(url); if(r) return _open.call(this,P+encodeURIComponent(r),'_blank',features);
    }
    return _open.apply(this,arguments);
  };

  // Webpack public path
  try{
    if(typeof __webpack_require__!=='undefined'&&__webpack_require__.p){
      var op=__webpack_require__.p; var ap=safeResolve(op)||op;
      __webpack_require__.p=P+encodeURIComponent(ap.endsWith('/')?ap:ap+'/');
    }
  }catch(e){}

  // history
  var _push=history.pushState, _repl=history.replaceState;
  function interceptState(u){ if(!u) return false; var r=safeResolve(u); if(!r) return false; navTo(r); return true; }
  history.pushState=function(s,t,u){ if(u&&interceptState(u)) return; return _push.apply(this,arguments); };
  history.replaceState=function(s,t,u){ if(u&&interceptState(u)) return; return _repl.apply(this,arguments); };

  // location.href / assign / replace
  function interceptLoc(u){ var r=safeResolve(u); if(!r) return false; navTo(r); return true; }
  try{
    var _ld=Object.getOwnPropertyDescriptor(Location.prototype,'href');
    if(_ld&&_ld.set){
      Object.defineProperty(Location.prototype,'href',{get:_ld.get,set:function(u){if(interceptLoc(u))return;_ld.set.call(this,u);}});
    }
    Location.prototype.assign=function(u){if(interceptLoc(u))return;window.location.href=u;};
    Location.prototype.replace=function(u){if(interceptLoc(u))return;if(_ld&&_ld.set)_ld.set.call(this,u);};
  }catch(e){}

  // createElement override for iframes, scripts, audio, video
  var _dce=document.createElement.bind(document);
  document.createElement=function(tag){
    var el=_dce(tag); var t=String(tag).toLowerCase();
    if(t==='audio'||t==='video'){
      try{
        var mSrc=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src');
        Object.defineProperty(el,'src',{
          get:function(){return mSrc?mSrc.get.call(this):'';},
          set:function(v){if(v&&typeof v==='string'&&/^https?:/.test(v)&&!v.includes('/proxy?url=')) v=P+encodeURIComponent(v);if(mSrc&&mSrc.set)mSrc.set.call(this,v);else el.setAttribute('src',v);},
          configurable:true
        });
      }catch(e){}
    }
    if(t==='iframe'||t==='frame'){
      try{
        var iSrc=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');
        Object.defineProperty(el,'src',{
          get:function(){return iSrc?iSrc.get.call(this):el.getAttribute('src');},
          set:function(v){var r=safeResolve(v);var val=r?P+encodeURIComponent(r):v;if(iSrc&&iSrc.set)iSrc.set.call(this,val);else el.setAttribute('src',val);},
          configurable:true
        });
      }catch(e){}
    }
    return el;
  };

  // HTMLMediaElement.src prototype override (for existing elements)
  try{
    var mProto=HTMLMediaElement.prototype;
    var mSrcD=Object.getOwnPropertyDescriptor(mProto,'src');
    if(mSrcD&&mSrcD.set){
      Object.defineProperty(mProto,'src',{
        get:mSrcD.get,
        set:function(v){if(v&&typeof v==='string'&&/^https?:/.test(v)&&!v.includes('/proxy?url=')) v=P+encodeURIComponent(v);mSrcD.set.call(this,v);},
        configurable:true
      });
    }
  }catch(e){}

  // Link clicks
  document.addEventListener('click',function(e){
    var a=e.target.closest('a'); if(!a) return;
    var h=a.getAttribute('href');
    if(!h||/^(#|javascript:|mailto:|tel:)/.test(h)) return;
    e.preventDefault(); e.stopPropagation();
    var r=safeResolve(h); if(r) navTo(r);
  },true);

  // Form submits
  document.addEventListener('submit',function(e){
    var f=e.target, m=(f.method||'GET').toUpperCase();
    var action=f.getAttribute('action');
    if(m==='GET'){
      e.preventDefault();
      var base=safeResolve(action||B); if(!base) return;
      navTo(base+'?'+new URLSearchParams(new FormData(f)));
    } else if(m==='POST'){
      e.preventDefault();
      var base2=safeResolve(action||B); if(!base2) return;
      fetch(P+encodeURIComponent(base2),{method:'POST',body:new FormData(f)})
        .then(r=>r.text()).then(html=>{document.open();document.write(html);document.close();}).catch(()=>{});
    }
  },true);

  // MutationObserver — catch dynamically injected elements
  try{
    new MutationObserver(function(muts){
      muts.forEach(function(m){
        m.addedNodes.forEach(function(node){
          if(!node.tagName) return;
          var tag=node.tagName.toUpperCase();
          var attrs=tag==='LINK'?['href']:['src'];
          attrs.forEach(function(attr){
            var v=node.getAttribute&&node.getAttribute(attr);
            if(v&&/^https?:/.test(v)&&!v.includes('/proxy?url=')) node.setAttribute(attr,P+encodeURIComponent(v));
          });
          ['data-src','data-lazy','data-original'].forEach(function(attr){
            var v=node.getAttribute&&node.getAttribute(attr);
            if(v&&/^https?:/.test(v)) node.setAttribute(attr,P+encodeURIComponent(v));
          });
        });
      });
    }).observe(document.documentElement,{childList:true,subtree:true});
  }catch(e){}
})();
<\/script>`;
}

// ─── YouTube via Invidious API ────────────────────────────────────────────────
// Invidious is an open-source YouTube frontend. Its public instances expose a
// JSON API that returns direct stream URLs — no bot detection, no API key,
// works fine from Vercel datacenter IPs. We try multiple instances and fall
// back automatically if one is down.
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.privacyredirect.com',
  'https://yt.cdaut.de',
  'https://invidious.nerdvpn.de',
  'https://iv.datura.network',
  'https://invidious.perennialte.ch',
];

async function getYouTubeInfo(videoId) {
  let lastErr;
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const resp = await axios.get(`${instance}/api/v1/videos/${videoId}`, {
        timeout: 8000, httpsAgent, validateStatus: () => true,
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      });
      if (resp.status === 200 && resp.data && (resp.data.adaptiveFormats || resp.data.formatStreams)) {
        return { data: resp.data, instance };
      }
      lastErr = new Error(`${instance} returned HTTP ${resp.status}`);
    } catch(e) {
      lastErr = e;
      console.warn(`[YT] Invidious instance ${instance} failed: ${e.message}`);
    }
  }
  throw lastErr || new Error('All Invidious instances failed');
}

function youtubePlayerPage(host, videoId, invData) {
  const title  = esc(invData.title  || 'YouTube Video');
  const author = esc(invData.author || '');

  // formatStreams = combined audio+video (up to 720p), easy to play directly
  // adaptiveFormats = separate video-only and audio-only streams (higher quality)
  const combined = (invData.formatStreams || [])
    .filter(f => f.url && f.resolution)
    .sort((a, b) => (parseInt(b.resolution)||0) - (parseInt(a.resolution)||0));

  const qualityOptions = combined.map(f => ({
    label: f.qualityLabel || f.resolution || f.quality || '?',
    url:   `https://${host}/yt-stream?url=${encodeURIComponent(f.url)}`,
    type:  f.type || 'video/mp4',
  }));

  const defaultUrl  = qualityOptions[0]?.url  || '';
  const defaultType = qualityOptions[0]?.type || 'video/mp4';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a12;color:#f0f0f5;font-family:"Segoe UI",system-ui,sans-serif;min-height:100vh}
    .topbar{background:rgba(8,8,18,.96);border-bottom:1px solid rgba(108,142,255,.2);padding:8px 16px;display:flex;align-items:center;gap:10px;font:600 11px/1 system-ui;letter-spacing:.05em}
    .wrap{max-width:900px;margin:0 auto;padding:20px 16px}
    .player-box{width:100%;background:#000;border-radius:10px;overflow:hidden;aspect-ratio:16/9;box-shadow:0 4px 32px rgba(0,0,0,.6)}
    video{width:100%;height:100%;display:block;outline:none}
    .vid-title{font-size:1.15rem;font-weight:700;margin:14px 0 4px}
    .vid-author{font-size:13px;color:rgba(255,255,255,.4);margin-bottom:10px}
    .quality-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}
    .qlabel{font-size:12px;color:rgba(255,255,255,.3);margin-right:4px}
    .q-btn{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:#f0f0f5;padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;transition:all .15s}
    .q-btn:hover{background:rgba(108,142,255,.2);border-color:rgba(108,142,255,.5)}
    .q-btn.active{background:rgba(108,142,255,.3);border-color:#6c8eff;color:#6c8eff;font-weight:700}
    .no-video{padding:60px 20px;text-align:center;color:rgba(255,255,255,.3)}
    .no-video h2{color:#6c8eff;margin-bottom:10px}
    .no-video p{margin-top:8px;font-size:13px}
  </style>
</head>
<body>
  <div class="topbar">
    <span style="color:#6c8eff">⬡ PROXY</span>
    <span style="background:rgba(255,30,30,.15);color:#ff4444;padding:1px 7px;border-radius:8px;border:1px solid rgba(255,30,30,.3);font-size:10px">▶ YOUTUBE</span>
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,.3);font-weight:400">youtube.com/watch?v=${esc(videoId)}</span>
    <a href="https://${host}/" style="color:rgba(108,142,255,.6);text-decoration:none">⬡ Home</a>
  </div>
  <div class="wrap">
    <div class="player-box">
      ${defaultUrl
        ? `<video id="vid" controls autoplay preload="auto" crossorigin="anonymous">
             <source src="${esc(defaultUrl)}" type="${esc(defaultType)}">
           </video>`
        : `<div class="no-video">
             <h2>Playback unavailable</h2>
             <p>No streamable formats found.</p>
             <p style="margin-top:8px;color:rgba(255,255,255,.2)">The video may be age-restricted, private, or region-locked.</p>
           </div>`
      }
    </div>
    <div class="vid-title">${title}</div>
    <div class="vid-author">${author}</div>
    ${qualityOptions.length > 1 ? `
    <div class="quality-bar">
      <span class="qlabel">Quality:</span>
      ${qualityOptions.map((q,i) => `<button class="q-btn${i===0?' active':''}" data-url="${esc(q.url)}" data-type="${esc(q.type)}">${esc(q.label)}</button>`).join('')}
    </div>` : ''}
  </div>
  <script>
  (function(){
    var vid=document.getElementById('vid');
    document.querySelectorAll('.q-btn').forEach(function(btn){
      btn.addEventListener('click',function(){
        var t=vid?vid.currentTime:0, paused=vid?vid.paused:true;
        document.querySelectorAll('.q-btn').forEach(function(b){b.classList.remove('active');});
        btn.classList.add('active');
        if(vid){
          vid.innerHTML='<source src="'+btn.getAttribute('data-url')+'" type="'+btn.getAttribute('data-type')+'">';
          vid.load(); vid.currentTime=t;
          if(!paused) vid.play().catch(function(){});
        }
      });
    });
  })();
  <\/script>
</body>
</html>`;
}

// ─── YouTube endpoints ────────────────────────────────────────────────────────
app.get('/yt', async (req, res) => {
  const urlParam = req.query.url || (req.query.v ? `https://www.youtube.com/watch?v=${req.query.v}` : null);
  const host = req.get('host');
  if (!urlParam) return res.status(400).send('Missing ?url= or ?v=');
  const videoId = extractYouTubeId(urlParam);
  if (!videoId) return res.status(400).send('Could not extract YouTube video ID');
  stripAndSetCors(res);
  res.set('Content-Type', 'text/html; charset=utf-8');
  try {
    const { data: invData, instance } = await getYouTubeInfo(videoId);
    console.log(`[YT] Got info for ${videoId} from ${instance}`);
    res.send(youtubePlayerPage(host, videoId, invData));
  } catch(err) {
    console.error('[YT]', err.message);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>YouTube Error</title></head>
    <body style="background:#0a0a12;color:#fff;font-family:system-ui;padding:40px;text-align:center">
    <h2 style="color:#f44;margin-bottom:12px">YouTube playback error</h2>
    <p style="color:rgba(255,255,255,.5);margin-bottom:16px">${esc(err.message)}</p>
    <p style="font-size:12px;color:rgba(255,255,255,.2)">All Invidious instances may be temporarily down. Try again in a moment.</p>
    <p style="margin-top:20px"><a href="https://${esc(host)}/" style="color:#6c8eff">← Back to home</a></p>
    </body></html>`);
  }
});

// Proxy the actual video bytes through our server with range-request support
// This is needed because Invidious stream URLs have CORS restrictions
app.get('/yt-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing ?url=');
  const rangeHdr = req.headers['range'];
  try {
    const headers = {
      'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity',
      'Referer': 'https://www.youtube.com/', 'Origin': 'https://www.youtube.com',
    };
    if (rangeHdr) headers['Range'] = rangeHdr;
    const upstream = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 30000, maxRedirects: 5,
      validateStatus: () => true, httpsAgent, headers,
    });
    const ct = upstream.headers['content-type'] || 'video/mp4';
    BLOCKED_HEADERS.forEach(h => res.removeHeader(h));
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', ct);
    res.set('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
    if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length']);
    if (upstream.headers['content-range'])  res.set('Content-Range',  upstream.headers['content-range']);
    res.status(upstream.status).send(upstream.data);
  } catch(e) {
    console.error('[YT-STREAM]', e.message);
    res.status(502).send('Stream error: ' + e.message);
  }
});

// ─── Twitch helpers ───────────────────────────────────────────────────────────
// Uses Twitch's GQL API with their own public web client_id.
// usher.twitch.tv is the correct domain (usher.twitchapps.com has DNS issues on Vercel).
const TWITCH_GQL  = 'https://gql.twitch.tv/gql';
const TWITCH_CID  = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const TWITCH_HDR  = { 'Client-Id': TWITCH_CID, 'Content-Type': 'application/json', 'User-Agent': UA, 'Referer': 'https://www.twitch.tv/', 'Origin': 'https://www.twitch.tv' };
const TWITCH_HASH = '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712';

// Two usher domains to try — first is the reliable one for Vercel
const USHER_HOSTS = ['usher.twitch.tv', 'usher.twitchapps.com'];

async function fetchUsher(path, params) {
  let lastErr;
  for (const host of USHER_HOSTS) {
    const url = `https://${host}${path}?${params}`;
    try {
      const resp = await axios.get(url, {
        timeout: 10000, validateStatus: () => true, httpsAgent,
        headers: { 'User-Agent': UA, 'Referer': 'https://www.twitch.tv/' },
      });
      if (resp.status === 200) return url; // return the URL that worked
      lastErr = new Error(`usher ${host} returned HTTP ${resp.status}`);
    } catch(e) {
      lastErr = e;
      console.warn(`[TWITCH] usher ${host} failed: ${e.message}`);
    }
  }
  throw lastErr || new Error('All usher hosts failed');
}

async function getTwitchStreamUrl(channel) {
  const resp = await axios.post(TWITCH_GQL,
    [{ operationName: 'PlaybackAccessToken',
       variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType: 'site' },
       extensions: { persistedQuery: { version: 1, sha256Hash: TWITCH_HASH } } }],
    { timeout: 10000, httpsAgent, validateStatus: () => true, headers: TWITCH_HDR }
  );
  const tokenData = resp.data?.[0]?.data?.streamPlaybackAccessToken;
  if (!tokenData) throw new Error('Channel is offline or not found: ' + channel);
  const { value, signature } = tokenData;
  const params = `sig=${encodeURIComponent(signature)}&token=${encodeURIComponent(value)}`
    + `&allow_source=true&allow_audio_only=true&fast_bread=true&p=${Math.floor(Math.random()*9999999)}`;
  return fetchUsher(`/api/channel/hls/${channel}.m3u8`, params);
}

async function getTwitchVodUrl(vodId) {
  const resp = await axios.post(TWITCH_GQL,
    [{ operationName: 'PlaybackAccessToken',
       variables: { isLive: false, login: '', isVod: true, vodID: vodId, playerType: 'site' },
       extensions: { persistedQuery: { version: 1, sha256Hash: TWITCH_HASH } } }],
    { timeout: 10000, httpsAgent, validateStatus: () => true, headers: TWITCH_HDR }
  );
  const tokenData = resp.data?.[0]?.data?.videoPlaybackAccessToken;
  if (!tokenData) throw new Error('VOD not found: ' + vodId);
  const { value, signature } = tokenData;
  const params = `sig=${encodeURIComponent(signature)}&token=${encodeURIComponent(value)}&allow_source=true`;
  return fetchUsher(`/vod/${vodId}.m3u8`, params);
}

function twitchPlayerPage(host, label, m3u8Url, isVod) {
  const proxyM3u8 = `https://${host}/proxy?url=${encodeURIComponent(m3u8Url)}`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(label)} — Twitch</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.8/dist/hls.min.js"><\/script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0e0e12;color:#f0f0f5;font-family:"Segoe UI",system-ui,sans-serif;min-height:100vh}
    .topbar{background:rgba(8,8,20,0.97);border-bottom:1px solid rgba(145,70,255,.25);padding:8px 16px;display:flex;align-items:center;gap:10px;font:600 11px/1 system-ui;letter-spacing:.05em}
    .wrap{max-width:960px;margin:0 auto;padding:20px 16px}
    .player-box{width:100%;background:#000;border-radius:10px;overflow:hidden;aspect-ratio:16/9;box-shadow:0 4px 32px rgba(0,0,0,.7)}
    video{width:100%;height:100%;display:block;outline:none;background:#000}
    .meta{margin-top:14px;display:flex;align-items:center;gap:10px}
    .live-badge{background:rgba(255,40,40,.15);color:#ff4444;border:1px solid rgba(255,40,40,.3);padding:3px 10px;border-radius:6px;font-size:12px;font-weight:700;letter-spacing:.1em}
    .channel-name{font-size:1.1rem;font-weight:700}
    .quality-bar{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center}
    .qlabel{font-size:12px;color:rgba(255,255,255,.3);margin-right:4px}
    .q-btn{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:#f0f0f5;padding:4px 12px;border-radius:14px;font-size:12px;cursor:pointer;transition:all .15s}
    .q-btn:hover,.q-btn.active{background:rgba(145,70,255,.2);border-color:#9146ff;color:#9146ff;font-weight:700}
    .status{font-size:12px;color:rgba(255,255,255,.3);margin-top:6px}
  </style>
</head>
<body>
  <div class="topbar">
    <span style="color:#9146ff">⬡ PROXY</span>
    <span style="background:rgba(145,70,255,.15);color:#9146ff;padding:1px 7px;border-radius:8px;border:1px solid rgba(145,70,255,.3);font-size:10px">🟣 TWITCH</span>
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,.3);font-weight:400">twitch.tv/${esc(label)}</span>
    <a href="https://${host}/" style="color:rgba(145,70,255,.6);text-decoration:none">⬡ Home</a>
  </div>
  <div class="wrap">
    <div class="player-box"><video id="vid" controls ${isVod?'':'autoplay'} playsinline></video></div>
    <div class="meta">
      ${!isVod ? '<span class="live-badge">● LIVE</span>' : ''}
      <span class="channel-name">${esc(label)}</span>
    </div>
    <div class="quality-bar" id="qbar">
      <span class="qlabel">Quality:</span>
      <span class="q-btn">Loading…</span>
    </div>
    <div class="status" id="status">Connecting to stream…</div>
  </div>
  <script>
  (function(){
    var M3U8=${JSON.stringify(proxyM3u8)};
    var PBASE=${JSON.stringify('https://'+host+'/proxy?url=')};
    var vid=document.getElementById('vid');
    var qbar=document.getElementById('qbar');
    var status=document.getElementById('status');

    // Safari native HLS fallback
    if(!Hls.isSupported()&&vid.canPlayType('application/vnd.apple.mpegurl')){
      vid.src=M3U8;
      vid.addEventListener('loadedmetadata',function(){ status.textContent='Playing (native HLS)'; });
      return;
    }

    var hls=new Hls({
      xhrSetup:function(xhr,url){
        if(url&&/^https?:/.test(url)&&!url.includes('/proxy?url='))
          xhr.open('GET',PBASE+encodeURIComponent(url),true);
      },
      enableWorker:true,
      lowLatencyMode:${!isVod},
      backBufferLength:90,
    });

    hls.loadSource(M3U8);
    hls.attachMedia(vid);

    hls.on(Hls.Events.MANIFEST_PARSED,function(){
      status.textContent='Stream ready ✓';
      var levels=hls.levels;
      qbar.innerHTML='<span class="qlabel">Quality:</span>';
      // Auto button
      var ab=document.createElement('button'); ab.className='q-btn active'; ab.textContent='Auto'; ab.dataset.level='-1';
      qbar.appendChild(ab);
      levels.forEach(function(l,i){
        var b=document.createElement('button');
        b.className='q-btn';
        b.textContent=(l.height?l.height+'p':'Level '+(i+1))+(l.bitrate?' ('+Math.round(l.bitrate/1000)+'k)':'');
        b.dataset.level=i;
        qbar.appendChild(b);
      });
      qbar.addEventListener('click',function(e){
        var btn=e.target.closest('.q-btn'); if(!btn||btn.dataset.level===undefined) return;
        qbar.querySelectorAll('.q-btn').forEach(function(b){b.classList.remove('active');});
        btn.classList.add('active');
        hls.currentLevel=parseInt(btn.dataset.level);
      });
      vid.play().catch(function(){});
    });

    hls.on(Hls.Events.ERROR,function(e,data){
      if(data.fatal){
        status.textContent='Error: '+data.details;
        if(data.type===Hls.ErrorTypes.NETWORK_ERROR){ setTimeout(function(){ hls.startLoad(); },3000); }
        else if(data.type===Hls.ErrorTypes.MEDIA_ERROR){ hls.recoverMediaError(); }
      }
    });

    hls.on(Hls.Events.FRAG_LOADING,function(){ status.textContent='Streaming…'; });
  })();
  <\/script>
</body>
</html>`;
}

// ─── Twitch endpoint ──────────────────────────────────────────────────────────
app.get('/twitch', async (req, res) => {
  const host    = req.get('host');
  const channel = (req.query.channel || '').toLowerCase().trim();
  const vod     = (req.query.vod || '').trim();
  if (!channel && !vod) return res.status(400).send('Missing ?channel= or ?vod=');
  stripAndSetCors(res);
  res.set('Content-Type', 'text/html; charset=utf-8');
  try {
    if (vod) {
      const m3u8Url = await getTwitchVodUrl(vod);
      return res.send(twitchPlayerPage(host, 'VOD ' + vod, m3u8Url, true));
    }
    const m3u8Url = await getTwitchStreamUrl(channel);
    return res.send(twitchPlayerPage(host, channel, m3u8Url, false));
  } catch(err) {
    console.error('[TWITCH]', err.message);
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Twitch Error</title></head>
    <body style="background:#0e0e12;color:#fff;font-family:system-ui;padding:40px;text-align:center">
    <h2 style="color:#9146ff;margin-bottom:12px">Twitch error</h2>
    <p style="color:rgba(255,255,255,.4)">${esc(err.message)}</p>
    <p style="margin-top:16px;font-size:12px;color:rgba(255,255,255,.2)">The channel may be offline, or Twitch may have updated their API.</p>
    <p style="margin-top:16px"><a href="https://${esc(host)}/" style="color:#9146ff">← Back to home</a></p>
    </body></html>`);
  }
});

// ─── Root (home page) ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const host = req.get('host');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Content-Security-Policy', 'frame-ancestors *');
  res.removeHeader('X-Frame-Options');
  res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CentOS Search</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}html,body{height:100%}
body{font-family:"Segoe UI",system-ui,sans-serif;background:#0a0a18;color:#f0f0f5;display:flex;flex-direction:column}
.page{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:32px}
.brand{display:flex;flex-direction:column;align-items:center;gap:10px}
.brand-icon{font-size:3.5rem;line-height:1}
.brand-name{font-size:2.4rem;font-weight:800;letter-spacing:-.5px;background:linear-gradient(135deg,#6c8eff 0%,#a78bfa 50%,#4ce8a0 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.brand-tag{font-size:13px;color:rgba(255,255,255,.35);letter-spacing:.05em}
.search-box{width:100%;max-width:580px;display:flex;flex-direction:column;gap:12px}
.search-row{display:flex;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:32px;overflow:hidden;transition:border-color .2s,box-shadow .2s}
.search-row:focus-within{border-color:rgba(108,142,255,.6);box-shadow:0 0 0 3px rgba(108,142,255,.12)}
.search-inp{flex:1;background:transparent;border:none;padding:14px 22px;color:#fff;font-size:16px;outline:none}
.search-inp::placeholder{color:rgba(255,255,255,.3)}
.search-btn{background:linear-gradient(135deg,#6c8eff,#a78bfa);border:none;padding:12px 24px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;border-radius:0 32px 32px 0;white-space:nowrap;transition:opacity .2s}
.search-btn:hover{opacity:.85}
.quick-links{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
.ql{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);border-radius:20px;padding:6px 14px;font-size:12px;color:rgba(255,255,255,.45);cursor:pointer;transition:all .2s;text-decoration:none}
.ql:hover{background:rgba(108,142,255,.15);border-color:rgba(108,142,255,.4);color:#6c8eff}
.ql.yt:hover{background:rgba(255,40,40,.15);border-color:rgba(255,40,40,.4);color:#ff4444}
.ql.tw:hover{background:rgba(145,70,255,.15);border-color:rgba(145,70,255,.4);color:#9146ff}
.footer{padding:16px;text-align:center;font-size:11px;color:rgba(255,255,255,.15)}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ce8a0;box-shadow:0 0 6px #4ce8a0;margin-right:5px}
</style>
</head><body>
<div class="page">
  <div class="brand">
    <span class="brand-icon">&#x2B21;</span>
    <span class="brand-name">CentOS Search</span>
    <span class="brand-tag">Private &bull; Fast &bull; Proxied</span>
  </div>
  <div class="search-box">
    <form class="search-row" id="sf">
      <input class="search-inp" id="qi" placeholder="Search, enter URL, or paste YouTube/Twitch link…" autofocus autocomplete="off" spellcheck="false"/>
      <button class="search-btn" type="submit">Search</button>
    </form>
    <div class="quick-links">
      <a class="ql yt" data-url="https://youtube.com">YouTube</a>
      <a class="ql tw" data-url="https://twitch.tv">Twitch</a>
      <a class="ql" data-url="https://reddit.com">Reddit</a>
      <a class="ql" data-url="https://github.com">GitHub</a>
      <a class="ql" data-url="https://twitter.com">Twitter / X</a>
      <a class="ql" data-url="https://wikipedia.org">Wikipedia</a>
      <a class="ql" data-url="https://instagram.com">Instagram</a>
      <a class="ql" data-url="https://discord.com">Discord</a>
    </div>
  </div>
</div>
<div class="footer"><span class="dot"></span>Online &mdash; CentOS Web Proxy</div>
<script>
var HOST="${host}";
function navTo(u){try{window.parent.postMessage({type:'centos-nav',url:u},'*')}catch(e){}setTimeout(function(){if(window.parent===window)window.location.href=u;},80);}
function routeUrl(raw){
  var full=/^https?:\\/\\//.test(raw)?raw:'https://'+raw;
  try{
    var u=new URL(full);
    if(u.hostname.includes('youtube.com')||u.hostname.includes('youtu.be')){
      navTo('https://'+HOST+'/yt?url='+encodeURIComponent(full)); return;
    }
    if(u.hostname.includes('twitch.tv')){
      var parts=u.pathname.split('/').filter(Boolean);
      if(parts[0]==='videos'&&parts[1]) navTo('https://'+HOST+'/twitch?vod='+parts[1]);
      else if(parts[0]) navTo('https://'+HOST+'/twitch?channel='+parts[0]);
      else navTo('https://'+HOST+'/proxy?url='+encodeURIComponent(full));
      return;
    }
  }catch(e){}
  navTo('https://'+HOST+'/proxy?url='+encodeURIComponent(full));
}
document.getElementById('sf').addEventListener('submit',function(e){
  e.preventDefault();
  var v=document.getElementById('qi').value.trim(); if(!v)return;
  if(/^https?:\\/\\//.test(v)||(/^[\\w-]+\\.\\w{2,}/.test(v)&&!v.includes(' '))){
    routeUrl(v);
  } else {
    navTo('https://'+HOST+'/search?q='+encodeURIComponent(v)+'&page=1');
  }
});
document.addEventListener('click',function(e){
  var a=e.target.closest('a[data-url]'); if(!a) return;
  e.preventDefault(); routeUrl(a.getAttribute('data-url'));
});
<\/script>
</body></html>`);
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'CentOS Web Proxy', twitch: true, port: PORT });
});

// ─── Search ───────────────────────────────────────────────────────────────────
async function fetchTavily(q) {
  const key = process.env.TAVILY_API_KEY; if (!key) throw new Error('TAVILY_API_KEY not set');
  const resp = await axios.post('https://api.tavily.com/search', { api_key: key, query: q, num_results: 50 },
    { timeout: 10000, httpsAgent, validateStatus: () => true, headers: { 'Content-Type': 'application/json' } });
  if (resp.status !== 200) throw new Error('Tavily HTTP ' + resp.status);
  return ((resp.data && resp.data.results) || [])
    .map(r => ({ title: r.title||'', href: r.url||'', snippet: r.content||'', displayUrl: r.url||'' })).filter(r => r.href);
}
async function fetchWiby(q) {
  const resp = await axios.get('https://wiby.me/json/?q='+encodeURIComponent(q),
    { timeout: 10000, httpsAgent, validateStatus: () => true, headers: { 'User-Agent': UA } });
  let data = resp.data; if (typeof data==='string') { try { data=JSON.parse(data); } catch(e) { return []; } }
  if (!data) return [];
  const items = Array.isArray(data) ? data : (data.results||[]);
  return items.map(r => ({ title: r.Title||r.title||'', href: r.URL||r.url||'', snippet: r.Snippet||r.snippet||'', displayUrl: r.URL||r.url||'' })).filter(r => r.href);
}

app.get('/search', async (req, res) => {
  const q = req.query.q, page = Math.max(1, parseInt(req.query.page)||1), PER = 10;
  if (!q) return res.status(400).send('Missing ?q=');
  const host = req.get('host');
  let allResults = [], source = '';
  try {
    if (process.env.TAVILY_API_KEY) { try { allResults = await fetchTavily(q); source = 'Tavily'; } catch(e) { console.warn('[SEARCH] Tavily:', e.message); } }
    if (!allResults.length) { try { allResults = await fetchWiby(q); source = 'Wiby'; } catch(e) { console.warn('[SEARCH] Wiby:', e.message); } }
    const totalPages = Math.max(1, Math.ceil(allResults.length/PER));
    const safePage = Math.min(page, totalPages);
    const results = allResults.slice((safePage-1)*PER, safePage*PER);
    var rHtml = results.length
      ? results.map(r => `<div class="result"><div class="ru">${esc(r.displayUrl)}</div><div class="rt"><a href="#" data-url="${esc(r.href)}">${esc(r.title)}</a></div><div class="rs">${esc(r.snippet)}</div></div>`).join('')
      : `<div class="nr">No results found.<br><br>Set <code>TAVILY_API_KEY</code> for full results.</div>`;
    var pH = '';
    if (totalPages>1) {
      pH='<div class="pager">';
      if(safePage>1) pH+=`<a class="pb" data-page="${safePage-1}">&laquo; Prev</a>`;
      for(var p=Math.max(1,safePage-2);p<=Math.min(totalPages,safePage+2);p++) pH+=p===safePage?`<span class="pb pc">${p}</span>`:`<a class="pb" data-page="${p}">${p}</a>`;
      if(safePage<totalPages) pH+=`<a class="pb" data-page="${safePage+1}">Next &raquo;</a>`;
      pH+='</div>';
    }
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(q)} — CentOS</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Segoe UI",system-ui,sans-serif;background:#0d0d1c;color:#f0f0f5;min-height:100vh;padding-bottom:60px}
.tb{background:rgba(10,10,25,.97);border-bottom:1px solid rgba(255,255,255,.08);padding:12px 24px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:99}
.logo{color:#6c8eff;font-size:18px;font-weight:700;white-space:nowrap}
.sf{display:flex;flex:1;gap:8px;max-width:600px}
.si{flex:1;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:22px;padding:8px 18px;color:#fff;font-size:14px;outline:none}
.sb{background:#6c8eff;border:none;border-radius:22px;padding:8px 18px;color:#fff;font-size:13px;font-weight:600;cursor:pointer}
.res{max-width:660px;margin:28px auto;padding:0 24px}
.rc{font-size:13px;color:rgba(255,255,255,.35);margin-bottom:20px}
.result{margin-bottom:28px;cursor:pointer}
.ru{font-size:12px;color:#4ce8a0;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt{font-size:18px;font-weight:500;margin-bottom:6px}.rt a{color:#6c8eff;text-decoration:none}
.rs{font-size:14px;color:rgba(240,240,245,.65);line-height:1.6}
.nr{text-align:center;padding:60px 20px;color:rgba(255,255,255,.35);font-size:15px}
.nr code{background:rgba(255,255,255,.06);padding:2px 7px;border-radius:4px;font-size:13px;color:#6c8eff}
.pager{display:flex;justify-content:center;gap:6px;margin-top:32px;flex-wrap:wrap}
.pb{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#f0f0f5;padding:7px 14px;border-radius:8px;font-size:13px;cursor:pointer;text-decoration:none}
.pb:hover{background:rgba(108,142,255,.2);border-color:rgba(108,142,255,.5)}
.pc{background:rgba(108,142,255,.25);border-color:#6c8eff;color:#6c8eff;font-weight:700;cursor:default}
.pw{text-align:center;font-size:11px;color:rgba(255,255,255,.15);margin-top:20px}</style>
</head><body>
<div class="tb"><span class="logo">&#x2B21; CentOS Search</span>
<form class="sf" id="sf"><input class="si" id="qi" value="${esc(q)}" placeholder="Search…"/><button class="sb" type="submit">Search</button></form></div>
<div class="res"><div class="rc">${allResults.length} result${allResults.length!==1?'s':''} for &ldquo;<strong>${esc(q)}</strong>&rdquo;</div>${rHtml}${pH}
<div class="pw">${source?'Powered by '+esc(source):'CentOS Web Proxy'}</div></div>
<script>var H="${host}",Q=${JSON.stringify(q)};
function navTo(u){try{window.parent.postMessage({type:'centos-nav',url:u},'*')}catch(e){}setTimeout(function(){window.location.href=u;},80);}
function routeResult(url){
  try{var u=new URL(url);
    if(u.hostname.includes('youtube.com')||u.hostname.includes('youtu.be')){navTo('https://'+H+'/yt?url='+encodeURIComponent(url));return;}
    if(u.hostname.includes('twitch.tv')){var parts=u.pathname.split('/').filter(Boolean);if(parts[0]==='videos'&&parts[1])navTo('https://'+H+'/twitch?vod='+parts[1]);else if(parts[0])navTo('https://'+H+'/twitch?channel='+parts[0]);return;}
  }catch(e){}
  navTo('https://'+H+'/proxy?url='+encodeURIComponent(url));
}
document.getElementById('sf').addEventListener('submit',function(e){e.preventDefault();var v=document.getElementById('qi').value.trim();if(v)navTo('https://'+H+'/search?q='+encodeURIComponent(v)+'&page=1');});
document.addEventListener('click',function(e){var c=e.target.closest('.result');if(c){e.preventDefault();var a=c.querySelector('a[data-url]');if(a)routeResult(a.getAttribute('data-url'));return;} var b=e.target.closest('a.pb');if(b){e.preventDefault();var pg=b.getAttribute('data-page');if(pg)navTo('https://'+H+'/search?q='+encodeURIComponent(Q)+'&page='+pg);}});
<\/script></body></html>`;
    res.set('Content-Type','text/html; charset=utf-8');
    stripAndSetCors(res);
    res.send(html);
  } catch(err) {
    res.status(200).set('Content-Type','text/html').send(`<html><body style="background:#0d0d1c;color:#fff;font-family:system-ui;padding:40px;text-align:center"><h2 style="color:#6c8eff">Search error</h2><p style="color:rgba(255,255,255,.5)">${esc(err.message)}</p></body></html>`);
  }
});

// ─── Proxy: HEAD ──────────────────────────────────────────────────────────────
app.head('/proxy', async (req, res) => {
  const raw = req.query.url; if (!raw) return res.status(400).end();
  try {
    const up = await axios.head(raw, { timeout: 10000, maxRedirects: 8, validateStatus: () => true, httpsAgent, headers: { 'User-Agent': UA } });
    stripAndSetCors(res);
    if (up.headers['content-type'])   res.set('Content-Type',   up.headers['content-type']);
    if (up.headers['content-length']) res.set('Content-Length', up.headers['content-length']);
    if (up.headers['accept-ranges'])  res.set('Accept-Ranges',  up.headers['accept-ranges']);
    res.status(up.status).end();
  } catch(e) { res.status(502).end(); }
});

// ─── Proxy: GET ───────────────────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('Missing ?url=');
  let target;
  try { target = new URL(raw); } catch { return res.status(400).send('Invalid URL'); }
  if (/^(localhost|127\.|192\.168\.|10\.|::1)/.test(target.hostname))
    return res.status(403).send('Private network access blocked');

  const host = req.get('host');

  // Redirect YouTube/Twitch to dedicated handlers
  if (isYouTubeUrl(raw) && extractYouTubeId(raw))
    return res.redirect(307, `https://${host}/yt?url=${encodeURIComponent(raw)}`);
  if (isTwitchUrl(raw)) {
    const parts = target.pathname.split('/').filter(Boolean);
    if (parts[0]==='videos'&&parts[1]) return res.redirect(307, `https://${host}/twitch?vod=${parts[1]}`);
    if (parts[0]) return res.redirect(307, `https://${host}/twitch?channel=${parts[0]}`);
  }

  const rangeHdr = req.headers['range'];
  try {
    // Range request for video seeking
    if (rangeHdr) {
      const upstream = await axios.get(raw, {
        responseType: 'arraybuffer', timeout: 30000, maxRedirects: 8, validateStatus: () => true, httpsAgent,
        headers: { 'User-Agent': UA, 'Range': rangeHdr, 'Accept': '*/*', 'Referer': target.origin, 'Origin': target.origin },
      });
      stripAndSetCors(res);
      res.set('Content-Type', upstream.headers['content-type'] || 'application/octet-stream');
      res.set('Accept-Ranges', 'bytes');
      if (upstream.headers['content-range'])  res.set('Content-Range',  upstream.headers['content-range']);
      if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length']);
      return res.status(upstream.status).send(upstream.data);
    }

    const upstream = await axios.get(raw, {
      responseType: 'arraybuffer', timeout: 20000, maxRedirects: 8, validateStatus: () => true, httpsAgent,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br', 'Referer': target.origin, 'Origin': target.origin },
    });
    const ct = upstream.headers['content-type'] || '';
    stripAndSetCors(res);

    // Binary passthrough
    if (/^(image|font)\/|octet-stream/.test(ct)) {
      res.set('Content-Type', ct); res.set('Cache-Control', 'public, max-age=86400'); return res.send(upstream.data);
    }
    // Audio / video passthrough with range support
    if (/^(video|audio)\//.test(ct)) {
      res.set('Content-Type', ct); res.set('Accept-Ranges', 'bytes');
      if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length']);
      return res.send(upstream.data);
    }
    if (/pdf/.test(ct)) { res.set('Content-Type', ct); return res.send(upstream.data); }

    const body = upstream.data.toString('utf-8');

    if (ct.includes('css')) {
      res.set('Content-Type', 'text/css; charset=utf-8');
      return res.send(rewriteCss(body, raw, host));
    }

    if (ct.includes('javascript') || ct.includes('ecmascript') || ct.includes('x-javascript')) {
      res.set('Content-Type', ct);
      return res.send(body.replace(/(["`])(https?:\/\/[^"`\s]{8,})(["`])/g, (m, q1, url, q2) =>
        (url.startsWith('data:')||url.includes('/proxy?url=')) ? m : q1+makeProxyUrl(url,host)+q2
      ));
    }

    // HLS m3u8 playlist
    if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || raw.includes('.m3u8')) {
      res.set('Content-Type', ct || 'application/vnd.apple.mpegurl');
      return res.send(body.replace(/^([^#\r\n][^\r\n]*)$/gm, line => {
        const t = line.trim(); if (!t) return line;
        const abs = resolveUrl(raw, t);
        return (abs && !abs.includes('/proxy?url=')) ? makeProxyUrl(abs, host) : line;
      }));
    }

    // DASH MPD
    if (ct.includes('dash+xml') || raw.includes('.mpd')) {
      res.set('Content-Type', ct || 'application/dash+xml');
      return res.send(body.replace(/(BaseURL|initialization|media|href)="([^"]+)"/g, (m, attr, url) => {
        const abs = resolveUrl(raw, url);
        return (!abs || abs.includes('/proxy?url=')) ? m : `${attr}="${makeProxyUrl(abs, host)}"`;
      }));
    }

    if (ct.includes('html') || ct.includes('xhtml')) {
      const $ = cheerio.load(body, { decodeEntities: false });
      $('meta[http-equiv="Content-Security-Policy"],meta[http-equiv="content-security-policy"],meta[http-equiv="X-Frame-Options"],meta[http-equiv="x-frame-options"],meta[http-equiv="Cross-Origin-Embedder-Policy"],meta[http-equiv="Cross-Origin-Opener-Policy"]').remove();

      // meta refresh rewrite
      $('meta[http-equiv="refresh"]').each((_,el) => {
        const c = $(el).attr('content')||''; const m = c.match(/^(\d+)(?:;\s*url=(.+))?$/i);
        if (m && m[2]) { const abs=resolveUrl(raw,m[2].trim()); if(abs) $(el).attr('content',m[1]+'; url='+makeProxyUrl(abs,host)); }
      });

      $('base').remove();
      $('head').prepend(`<base href="${raw}">`);

      const rw = (el, attr) => {
        const v = $(el).attr(attr); if (!v) return;
        const abs = resolveUrl(raw, v);
        if (abs && !/^(javascript:|data:|#|mailto:|tel:|blob:)/.test(abs)) $(el).attr(attr, makeProxyUrl(abs, host));
      };

      $('a[href]').each((_,el)       => rw(el,'href'));
      $('link[href]').each((_,el)    => rw(el,'href'));
      $('script[src]').each((_,el)   => rw(el,'src'));
      $('link[rel="modulepreload"]').each((_,el) => rw(el,'href'));
      $('link[rel="preload"]').each((_,el)       => rw(el,'href'));
      $('link[rel="prefetch"]').each((_,el)      => rw(el,'href'));
      $('img[src]').each((_,el)      => rw(el,'src'));
      $('img[srcset],source[srcset]').each((_,el) => {
        const s = $(el).attr('srcset')||'';
        $(el).attr('srcset', s.split(',').map(p => { const [u,sz]=p.trim().split(/\s+/); return makeProxyUrl(resolveUrl(raw,u),host)+(sz?' '+sz:''); }).join(', '));
      });
      ['data-src','data-lazy','data-original','data-lazy-src'].forEach(attr => {
        $(`[${attr}]`).each((_,el) => { const v=$(el).attr(attr); if(!v) return; const abs=resolveUrl(raw,v); if(abs&&/^https?:/.test(abs)) $(el).attr(attr,makeProxyUrl(abs,host)); });
      });
      $('iframe[src],frame[src]').each((_,el)  => rw(el,'src'));
      $('video[src],audio[src],source[src]').each((_,el) => rw(el,'src'));
      $('video[poster]').each((_,el)            => rw(el,'poster'));
      $('track[src]').each((_,el)               => rw(el,'src'));
      $('form[action]').each((_,el)             => rw(el,'action'));
      $('[style]').each((_,el) => $(el).attr('style', rewriteCss($(el).attr('style'),raw,host)));
      $('style').each((_,el)  => $(el).html(rewriteCss($(el).html(),raw,host)));
      $('script:not([src])').each((_,el) => {
        const code = $(el).html()||'';
        $(el).html(code.replace(/(["`])(https?:\/\/[^"`\s]{8,})(["`])/g, (m,q1,url,q2) =>
          (url.startsWith('data:')||url.includes('/proxy?url='))?m:q1+makeProxyUrl(url,host)+q2
        ));
      });
      $('script[type="importmap"]').each((_,el) => {
        try {
          const map=JSON.parse($(el).html()||'{}');
          const remap=o=>Object.keys(o).forEach(k=>{const abs=resolveUrl(raw,o[k]);if(abs)o[k]=makeProxyUrl(abs,host);});
          if(map.imports)remap(map.imports);
          if(map.scopes)Object.keys(map.scopes).forEach(s=>remap(map.scopes[s]));
          $(el).html(JSON.stringify(map));
        }catch(e){}
      });
      $('video,audio').each((_,el) => $(el).attr('crossorigin','anonymous'));

      $('body').prepend(`
        <div id="_cbar" style="position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647;background:rgba(8,8,18,.96);backdrop-filter:blur(16px);border-bottom:1px solid rgba(108,142,255,.2);display:flex;align-items:center;padding:0 12px;gap:8px;font:600 11px/1 system-ui;letter-spacing:.05em">
          <span style="color:#6c8eff">⬡ PROXY</span>
          <span style="background:rgba(76,232,160,.12);color:#4ce8a0;padding:1px 7px;border-radius:8px;border:1px solid rgba(76,232,160,.25);font-size:10px">SECURE</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,.35);font-weight:400">${raw}</span>
          <a href="https://${host}/proxy?url=${encodeURIComponent(raw)}" style="color:rgba(108,142,255,.6);text-decoration:none" title="Reload">↻</a>
          <a href="${raw}" target="_blank" style="color:rgba(255,255,255,.25);text-decoration:none" title="Open original">↗</a>
        </div>
        <div style="height:28px"></div>
        ${injectedJs(raw, host)}
      `);
      res.set('Content-Type','text/html; charset=utf-8');
      return res.send($.html());
    }

    res.set('Content-Type', ct || 'text/plain');
    res.send(body);
  } catch(err) {
    console.error(`[PROXY] ${raw} ->`, err.message);
    const code = err.code==='ECONNREFUSED'?502:err.code==='ETIMEDOUT'?504:500;
    res.status(code).send(`Proxy error: ${err.message}`);
  }
});

// ─── Proxy: POST ──────────────────────────────────────────────────────────────
app.post('/proxy', async (req, res) => {
  const raw = req.query.url; if (!raw) return res.status(400).send('Missing ?url=');
  try {
    const r = await axios.post(raw, req.body, { timeout: 15000, validateStatus: () => true, httpsAgent, headers: { 'User-Agent': UA, 'Content-Type': req.get('content-type')||'application/x-www-form-urlencoded' } });
    stripAndSetCors(res);
    res.set('Content-Type', r.headers['content-type']||'text/html');
    res.send(r.data);
  } catch(e) { res.status(500).send(e.message); }
});

// ─── OPTIONS pre-flight ───────────────────────────────────────────────────────
app.options('*', (_req, res) => {
  res.set('Access-Control-Allow-Origin','*');
  res.set('Access-Control-Allow-Methods','GET, POST, HEAD, OPTIONS');
  res.set('Access-Control-Allow-Headers','*');
  res.set('Access-Control-Expose-Headers','Content-Length, Content-Range, Accept-Ranges');
  res.status(204).end();
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use(function(err, req, res, next) {
  console.error('[UNHANDLED]', err.message);
  res.status(200).set('Content-Type','text/plain').send('Error: ' + err.message);
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  ⬡  CentOS Web Proxy — YouTube + Twitch Edition`);
    console.log(`  ──────────────────────────────────────────────────`);
    console.log(`  ✓  Running  ->  http://localhost:${PORT}`);
    console.log(`  ✓  YouTube  ->  http://localhost:${PORT}/yt?url=https://youtube.com/watch?v=dQw4w9WgXcQ`);
    console.log(`  ✓  Twitch   ->  http://localhost:${PORT}/twitch?channel=shroud`);
    console.log(`  ✓  Health   ->  http://localhost:${PORT}/health`);
    console.log();
  });
}
