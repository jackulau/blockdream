// The self-contained capture page the bridge serves at GET / on its own port. Dependency-free
// (no build step, no imports): getDisplayMedia captures any screen/window/tab, a downscaled canvas
// is the live block-resolution preview, and each frame is packed to the exact wire format in
// screenshare-bridge.ts (uint16 W, uint16 H, RGB) and streamed over WebSocket back to this same
// origin. The bridge relays it into Minecraft. One port, one page, share -> watch it in-game.
//
// This is a STRING (the page can't import from the workspace), so the encoder here is hand-written
// to match encodeFrameMessage byte-for-byte; test/screenshare-bridge.test.ts locks that contract by
// decoding a buffer built the same way. Keep the two in sync.

export interface CapturePageOptions {
  /** Block-grid width the screen is downscaled to (the wall's X span). */
  width: number;
  /** Block-grid height (the wall's Y span). */
  height: number;
  /** Capture + send rate cap, frames/sec. */
  fps: number;
}

/** Render the capture page HTML with the wall grid + fps baked in. */
export function capturePageHtml({ width, height, fps }: CapturePageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>blockdream · screen share to Minecraft</title>
<style>
  :root { --sumi:#0e0e10; --ink:#f4f1ea; --muted:#9a978f; --jade:#5fd0a6; --line:#26262b; }
  * { box-sizing: border-box; }
  html,body { margin:0; height:100%; }
  body {
    background: radial-gradient(120% 90% at 50% -10%, #17171b 0%, var(--sumi) 60%);
    color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    display:flex; flex-direction:column; align-items:center; padding:5vh 4vw;
  }
  h1 { font-family: "Iowan Old Style", Palatino, Georgia, serif; font-weight:600; font-size:clamp(28px,5vw,44px);
       letter-spacing:-.02em; margin:0 0 .1em; }
  .jp { color:var(--muted); font-size:13px; letter-spacing:.35em; text-transform:uppercase; margin-bottom:1.4em; }
  .card { width:min(880px,100%); border:1px solid var(--line); border-radius:14px; background:#131317;
          padding:22px; box-shadow:0 20px 60px -30px #000; }
  .previewWrap { position:relative; border-radius:10px; overflow:hidden; background:#000;
                 aspect-ratio: ${width} / ${height}; display:flex; align-items:center; justify-content:center; }
  canvas#grid { width:100%; height:100%; image-rendering:pixelated; display:block; }
  .placeholder { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
                 color:var(--muted); font-size:14px; text-align:center; padding:0 8%; }
  video#cap { display:none; }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-top:18px; }
  button { font:inherit; font-weight:600; border:0; border-radius:9px; padding:11px 20px; cursor:pointer;
           background:var(--jade); color:#06251a; transition:filter .15s, opacity .15s; }
  button:hover { filter:brightness(1.08); }
  button.ghost { background:transparent; color:var(--ink); border:1px solid var(--line); }
  button:disabled { opacity:.4; cursor:not-allowed; filter:none; }
  .stats { margin-left:auto; display:flex; gap:20px; color:var(--muted); font-size:13px; }
  .stats b { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#b5514f; margin-right:6px; vertical-align:middle; }
  .dot.on { background:var(--jade); }
  .hint { color:var(--muted); font-size:13px; margin-top:16px; }
  .grid-meta { color:var(--muted); font-size:12px; margin-top:10px; letter-spacing:.02em; }
  code { color:var(--jade); background:#0b0b0d; padding:1px 6px; border-radius:5px; }
  footer { margin-top:22px; color:var(--muted); font-size:12px; }
  footer a { color:var(--jade); text-decoration:none; }
  footer a:hover { text-decoration:underline; }
</style>
</head>
<body>
  <h1>screen share &rarr; Minecraft</h1>
  <div class="jp">画面共有 · live to a block wall</div>
  <div class="card">
    <div class="previewWrap">
      <canvas id="grid" width="${width}" height="${height}"></canvas>
      <div class="placeholder" id="ph">Your shared screen previews here at ${width}&times;${height} blocks - exactly what appears in Minecraft.</div>
    </div>
    <div class="row">
      <button id="shareBtn">Share a screen</button>
      <button id="stopBtn" class="ghost" disabled>Stop</button>
      <div class="stats">
        <span><span class="dot" id="wsdot"></span><span id="ws">connecting</span></span>
        <span>sent <b id="sent">0</b></span>
        <span>painted <b id="painted">0</b></span>
        <span><b id="rate">0</b> fps</span>
        <span id="mode"></span>
      </div>
    </div>
    <div class="grid-meta">grid <code>${width}&times;${height}</code> · cap <code>${fps} fps</code> · the bridge relays each frame to Minecraft over RCON.</div>
    <div class="hint" id="status">Pick a screen, window, or browser tab. It streams to this port and into your world - no upload, all local.</div>
  </div>
  <footer>part of <a href="https://github.com/jackulau/blockdream" target="_blank" rel="noopener">blockdream</a> · <a href="https://github.com/jackulau/blockdream/blob/master/docs/screen-share.md" target="_blank" rel="noopener">how screen share works</a></footer>
<script>
(function(){
  var W = ${width}, H = ${height}, FPS = ${fps};
  var ws = null, stream = null, timer = null, framesSent = 0, connected = false, lastRateT = 0, lastRateN = 0;
  var lastPaintedSeen = -1, lastSentSeen = 0, stalledPolls = 0, stallWarned = false;
  var SHARING_MSG = 'Sharing live to Minecraft. Walk up to the wall in-game to watch.';
  var grid = document.getElementById('grid');
  var gctx = grid.getContext('2d', { willReadFrequently: true });
  var video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  function stat(id, v){ var el = document.getElementById(id); if (el) el.textContent = v; }
  function setWs(state, on){ stat('ws', state); document.getElementById('wsdot').className = 'dot' + (on ? ' on' : ''); connected = !!on; }
  function secureOriginHint(){
    return 'open http://127.0.0.1:' + (location.port || '8770') + ' on the machine running the bridge, or serve this page over https';
  }

  // getDisplayMedia only exists on a secure origin (https, or plain http on localhost). On a LAN
  // http:// host (--host 0.0.0.0) or iOS Safari, navigator.mediaDevices is undefined and calling
  // through it is a SYNCHRONOUS TypeError the promise .catch never sees - so detect up front,
  // gate the button, and say exactly how to fix it instead of a silently dead button.
  var captureSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  if (!captureSupported){
    document.getElementById('shareBtn').disabled = true;
    stat('status', 'Screen capture is unavailable here: browsers only allow it on a secure origin - ' + secureOriginHint() + '.');
  }

  function connect(){
    // constructor throw and onclose take the SAME 1s retry path - a throw here (bad URL edge,
    // proxy quirk) used to set a dead-end 'failed' state while onclose retried forever
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host); }
    catch (e) { setWs('reconnecting', false); setTimeout(connect, 1000); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = function(){ setWs('connected', true); };
    ws.onclose = function(){ setWs('reconnecting', false); setTimeout(connect, 1000); };
    ws.onerror = function(){ try { ws.close(); } catch (e) {} };
  }
  connect();

  // Bridge truth: 'sent' only proves frames left the browser. The bridge's /stats (same origin)
  // reports framesPainted - what actually reached Minecraft - so poll it ~1s, show painted next
  // to sent, surface dry-run mode, and warn when sends keep flowing but painted stalls
  // (RCON down, wrong password, server gone: the bridge logs it, now the page says it too).
  function pollStats(){
    fetch('/stats').then(function(r){ return r.json(); }).then(function(s){
      stat('painted', s.framesPainted);
      stat('mode', s.dryRun ? 'dry-run (no RCON)' : '');
      var sending = framesSent > lastSentSeen;
      var advanced = s.framesPainted !== lastPaintedSeen;
      lastSentSeen = framesSent;
      lastPaintedSeen = s.framesPainted;
      if (stream && sending && !advanced) stalledPolls++; else stalledPolls = 0;
      if (stalledPolls >= 3 && !stallWarned){
        stallWarned = true;
        stat('status', 'Frames are not reaching the server - check the bridge terminal / RCON password.');
      } else if (stallWarned && advanced){
        stallWarned = false;
        if (stream) stat('status', SHARING_MSG);
      }
    }).catch(function(){});
  }
  setInterval(pollStats, 1000);

  function share(){
    try {
      navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FPS }, audio: false }).then(function(s){
        stream = s;
        video.srcObject = s;
        video.play();
        s.getVideoTracks()[0].addEventListener('ended', stop);
        document.getElementById('ph').style.display = 'none';
        document.getElementById('shareBtn').disabled = true;
        document.getElementById('stopBtn').disabled = false;
        stat('status', SHARING_MSG);
        lastRateT = performance.now(); lastRateN = 0;
        if (timer) clearInterval(timer);
        timer = setInterval(tick, Math.max(16, Math.round(1000 / FPS)));
      }).catch(function(e){ stat('status', 'Capture cancelled (' + (e && e.message ? e.message : e) + ').'); });
    } catch (e) {
      stat('status', 'Screen capture failed to start (' + (e && e.message ? e.message : e) + ') - ' + secureOriginHint() + '.');
    }
  }

  function tick(){
    if (!video.videoWidth) return;
    gctx.drawImage(video, 0, 0, W, H);            // downscale the shared screen to the block grid
    var img;
    try { img = gctx.getImageData(0, 0, W, H); } catch (e) { return; } // tainted frame guard
    var now = performance.now();
    if (now - lastRateT >= 1000){ stat('rate', Math.round((framesSent - lastRateN) * 1000 / (now - lastRateT))); lastRateT = now; lastRateN = framesSent; }
    if (!connected || !ws || ws.readyState !== 1) return;
    var rgba = img.data, n = W * H, msg = new Uint8Array(4 + n * 3), dv = new DataView(msg.buffer);
    dv.setUint16(0, W, true); dv.setUint16(2, H, true);          // header: matches encodeFrameMessage
    var o = 4;
    for (var i = 0; i < n; i++){ var p = i * 4; msg[o++] = rgba[p]; msg[o++] = rgba[p + 1]; msg[o++] = rgba[p + 2]; }
    ws.send(msg);
    framesSent++; stat('sent', framesSent);
  }

  function stop(){
    if (timer){ clearInterval(timer); timer = null; }
    if (stream){ stream.getTracks().forEach(function(t){ t.stop(); }); stream = null; }
    // per-session counters: the next share starts from 0 instead of inheriting this session's count
    framesSent = 0; lastRateN = 0; lastSentSeen = 0; stalledPolls = 0; stallWarned = false;
    stat('sent', 0);
    document.getElementById('ph').style.display = '';
    document.getElementById('shareBtn').disabled = !captureSupported;
    document.getElementById('stopBtn').disabled = true;
    stat('status', 'Stopped. Share again anytime.');
    stat('rate', 0);
  }

  document.getElementById('shareBtn').onclick = share;
  document.getElementById('stopBtn').onclick = stop;
})();
</script>
</body>
</html>
`;
}
