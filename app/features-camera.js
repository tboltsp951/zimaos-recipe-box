/* Recipe Box v3 - camera capture layer.
   Preview dialog with live video, camera picker (when several cameras exist),
   and multiple photos per recipe (for recipes that span several pages).
   Loaded after features-sync.js. */

var CAM_MAX_PHOTOS = 12;

function camStatus(msg, kind) {
  if (typeof setStatus === 'function' && document.getElementById('iStatus')) setStatus('iStatus', msg, kind);
  else if (msg) toast(msg);
}

function camStopStream(stream) {
  if (!stream) return;
  try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
}

function camHasMediaDevices() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/* Capture one frame from the live <video> as a JPEG data URL.
   Text-heavy subjects (printed pages, handwritten cards) need far more linear
   resolution than photos do, so this keeps a high cap and high JPEG quality.
   The result is a data URL, so cost is bytes in the API call, not storage. */
var CAM_MAX_EDGE = 2560;
var CAM_JPEG_QUALITY = 0.92;
/* Capture modes: plain photo, boosted contrast, or grayscale. Pencil and
   faded ink read much better with a boost. */
var CAM_MODES = { plain: 'Plain', boost: 'Boost', gray: 'B&W' };

function camStretch(v, black, span) {
  var o = ((v - black) / span) * 255;
  return o < 0 ? 0 : (o > 255 ? 255 : o);
}

/* Adaptive contrast stretch: find the paper white and the darkest ink, then
   remap between them. Sampling a sparse grid keeps this cheap on large frames. */
function camBoostCanvas(c, mode) {
  if (!mode || mode === 'plain') return c;
  var ctx = c.getContext('2d');
  var img = ctx.getImageData(0, 0, c.width, c.height);
  var d = img.data;
  var hist = [];
  for (var h = 0; h < 256; h++) hist[h] = 0;
  var step = 16;   // sample every 4th pixel
  var count = 0;
  for (var i = 0; i < d.length; i += step) {
    var g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    hist[g]++;
    count++;
  }
  if (!count) return c;
  var white = 255, black = 0, acc = 0, v;
  // 2% brightest pixels are treated as paper (ignores glare hot-spots).
  for (v = 255; v >= 0; v--) { acc += hist[v]; if (acc > count * 0.02) { white = v; break; } }
  acc = 0;
  for (v = 0; v < 256; v++) { acc += hist[v]; if (acc > count * 0.01) { black = v; break; } }
  if (white - black < 30) { white = 255; black = 0; }
  var span = Math.max(1, white - black);
  var gray = mode === 'gray';
  for (var j = 0; j < d.length; j += 4) {
    if (gray) {
      var y = camStretch((d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114) | 0, black, span);
      d[j] = d[j + 1] = d[j + 2] = y;
    } else {
      d[j] = camStretch(d[j], black, span);
      d[j + 1] = camStretch(d[j + 1], black, span);
      d[j + 2] = camStretch(d[j + 2], black, span);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function camGrabFrame(video, mode) {
  var w = video.videoWidth || 0;
  var h = video.videoHeight || 0;
  if (!w || !h) return '';
  var k = Math.min(1, CAM_MAX_EDGE / Math.max(w, h));
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  var ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(video, 0, 0, c.width, c.height);
  return camBoostCanvas(c, mode || 'plain').toDataURL('image/jpeg', CAM_JPEG_QUALITY);
}

/* Reported capture size, shown in the preview dialog so the user knows what
   they are about to send. */
function camFrameSize(video) {
  var w = video.videoWidth || 0;
  var h = video.videoHeight || 0;
  if (!w || !h) return '';
  var k = Math.min(1, CAM_MAX_EDGE / Math.max(w, h));
  return Math.round(w * k) + ' × ' + Math.round(h * k) + ' px';
}

async function camListDevices() {
  if (!camHasMediaDevices()) return [];
  try {
    var all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(function (d) { return d.kind === 'videoinput'; });
  } catch (e) {
    return [];
  }
}

/* Open the preview dialog. Resolves with { photos } on Done, or null if cancelled. */
function camOpenPreview(devices, startIndex) {
  return new Promise(function (resolve) {
    var picked = startIndex || 0;
    var photos = [];
    var stream = null;
    var streamToken = 0;   // guards against a slow devicechange overwriting a newer stream
    var settled = false;

    var dlg = document.createElement('dialog');
    dlg.id = 'camDialog';
    dlg.className = 'cam-dialog';
    dlg.innerHTML =
      '<h2 style="margin-top:0">Take recipe photos</h2>' +
      '<p class="small">Frame the page, then press <strong>Capture</strong>. Repeat for every page, then press <strong>Use photos</strong>.</p>' +
      (devices.length > 1
        ? '<label for="camSelect">Camera</label><select id="camSelect">' +
          devices.map(function (d, i) {
            return '<option value="' + i + '"' + (i === picked ? ' selected' : '') + '>' +
              esc(d.label || ('Camera ' + (i + 1))) + '</option>';
          }).join('') + '</select>'
        : '') +
      '<div class="cam-tools">' +
      '<label class="ck"><input type="checkbox" id="camGrid"> Grid</label>' +
      '<label class="ck"><input type="checkbox" id="camTimer"> 3s timer</label>' +
      '<label class="ck"><input type="checkbox" id="camTorch" disabled> Torch</label>' +
      '<label for="camMode" style="margin:0">Capture</label>' +
      '<select id="camMode" style="width:auto;padding:3px 6px;font-size:.84rem">' +
      Object.keys(CAM_MODES).map(function (k) { return '<option value="' + k + '">' + CAM_MODES[k] + '</option>'; }).join('') +
      '</select>' +
      '</div>' +
      '<div class="cam-stage"><video id="camVideo" autoplay muted playsinline></video>' +
      '<div class="cam-grid" id="camGridOverlay" aria-hidden="true">' +
      '<span class="cg v1"></span><span class="cg v2"></span><span class="cg h1"></span><span class="cg h2"></span></div>' +
      '<div class="cam-countdown" id="camCountdown" aria-live="polite"></div>' +
      '<div class="cam-fallback" id="camFallback">Waiting for the camera…</div></div>' +
      '<div class="cam-meta"><span id="camSize"></span></div>' +
      '<label class="ck" style="margin:6px 0"><input type="checkbox" id="camHand"> This is a handwritten recipe card</label>' +
      '<p class="hint" style="margin:0 0 6px">Leave this off for printed pages and typed recipes. Turn it on for handwriting so uncertain words are marked <code>[?]</code> instead of guessed.</p>' +
      '<div class="cam-count" id="camCount">0 photo(s) captured</div>' +
      '<div class="cam-strip" id="camStrip"></div>' +
      '<div class="row" style="justify-content:flex-start;flex-wrap:wrap">' +
      '<button class="primary" id="camShoot">Capture</button>' +
      '<button id="camDone" disabled>Use photos (' + (1) + ')</button>' +
      '<button class="danger" id="camRetake" disabled>Start over</button>' +
      '<button id="camCancel">Cancel</button></div>';

    document.body.appendChild(dlg);

    var video = dlg.querySelector('#camVideo');
    var strip = dlg.querySelector('#camStrip');
    var countEl = dlg.querySelector('#camCount');
    var fallback = dlg.querySelector('#camFallback');
    var shootBtn = dlg.querySelector('#camShoot');
    var doneBtn = dlg.querySelector('#camDone');
    var retakeBtn = dlg.querySelector('#camRetake');
    var cancelBtn = dlg.querySelector('#camCancel');
    var selectEl = dlg.querySelector('#camSelect');
    var gridEl = dlg.querySelector('#camGrid');
    var gridOverlay = dlg.querySelector('#camGridOverlay');
    var timerEl = dlg.querySelector('#camTimer');
    var torchEl = dlg.querySelector('#camTorch');
    var countdownEl = dlg.querySelector('#camCountdown');
    if (gridOverlay) gridOverlay.style.display = 'none';

    function labelDone() {
      doneBtn.textContent = photos.length ? ('Use ' + photos.length + ' photo(s)') : 'Use photos';
      doneBtn.disabled = photos.length === 0;
      retakeBtn.disabled = photos.length === 0;
      countEl.textContent = photos.length + ' of ' + CAM_MAX_PHOTOS + ' photo(s) captured';
      shootBtn.disabled = photos.length >= CAM_MAX_PHOTOS;
    }

    function renderStrip() {
      strip.innerHTML = '';
      photos.forEach(function (p, i) {
        var wrap = document.createElement('div');
        wrap.className = 'cam-thumb';
        var img = document.createElement('img');
        img.src = p.url;
        img.alt = 'Photo ' + (i + 1);
        var num = document.createElement('span');
        num.className = 'cam-thumb-num';
        num.textContent = String(i + 1);
        var del = document.createElement('button');
        del.type = 'button';
        del.textContent = '×';
        del.setAttribute('aria-label', 'Remove photo ' + (i + 1));
        del.onclick = function () { photos.splice(i, 1); renderStrip(); labelDone(); };
        wrap.appendChild(img);
        wrap.appendChild(num);
        wrap.appendChild(del);
        strip.appendChild(wrap);
      });
      if (!photos.length) {
        var hint = document.createElement('div');
        hint.className = 'small cam-empty';
        hint.textContent = 'No photos yet. Press Capture to add the page in front of the camera.';
        strip.appendChild(hint);
      }
    }

    if (gridEl) {
      gridEl.onchange = function () {
        if (gridOverlay) gridOverlay.style.display = this.checked ? 'block' : 'none';
      };
    }
    void gridEl; void gridOverlay; void timerEl; void countdownEl;

    var torchOn = false;
    async function setTorch(on) {
      if (!stream) return false;
      var track = stream.getVideoTracks()[0];
      if (!track || !track.applyConstraints) return false;
      try {
        await track.applyConstraints({ advanced: [{ torch: !!on }] });
        return true;
      } catch (e) {
        return false;
      }
    }

    if (torchEl) {
      torchEl.onchange = async function () {
        var want = this.checked;
        var ok = await setTorch(want);
        if (!ok) {
          this.checked = false;
          torchOn = false;
          camStatus('This camera has no torch/flash control.', 'err');
        } else {
          torchOn = want;
        }
      };
    }

    /* Detect torch capability once a stream is live, so the control only
       appears when the device can actually do it. */
    async function probeTorch() {
      if (!torchEl || !stream) return;
      var track = stream.getVideoTracks()[0];
      var caps = {};
      try { caps = (track && track.getCapabilities && track.getCapabilities()) || {}; } catch (e) {}
      if (caps.torch) {
        torchEl.disabled = false;
        torchEl.closest('label').style.display = '';
      } else {
        torchEl.closest('label').style.display = 'none';
      }
    }

    function stop() {
      streamToken++;
      // Never leave the torch burning after the dialog closes.
      if (stream) {
        var tr = stream.getVideoTracks()[0];
        if (tr && tr.applyConstraints) {
          try {
            var p = tr.applyConstraints({ advanced: [{ torch: false }] });
            if (p && p.catch) p.catch(function () {});
          } catch (e) {}
        }
      }
      camStopStream(stream);
      stream = null;
    }

    async function start(idx) {
      var my = ++streamToken;
      camStopStream(stream);
      stream = null;
      fallback.style.display = 'block';
      fallback.textContent = 'Waiting for the camera…';
      var constraints = { audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1080 } } };
      var dev = devices[idx];
      if (dev && dev.deviceId) constraints.video.deviceId = { exact: dev.deviceId };
      else constraints.video.facingMode = { ideal: 'environment' };
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true }); }
        catch (e2) {
          fallback.textContent = 'Camera unavailable: ' + (e2.message || e2);
          fallback.classList.add('err');
          return;
        }
      }
      if (my !== streamToken) { camStopStream(stream); return; }   // a newer request won
      video.srcObject = stream;
      try { await video.play(); } catch (e) {}
      var sizeEl = dlg.querySelector('#camSize');
      var ready = function () {
        if (my !== streamToken) return;
        if (!video.videoWidth) { setTimeout(ready, 120); return; }
        fallback.style.display = 'none';
        if (sizeEl) sizeEl.textContent = 'Capture size: ' + camFrameSize(video) + ' JPEG';
      };
      ready();
      probeTorch();
    }

    shootBtn.onclick = async function () {
      if (photos.length >= CAM_MAX_PHOTOS) { camStatus('Reached ' + CAM_MAX_PHOTOS + ' photos.', 'err'); return; }

      // Optional 3-2-1 so the phone can be held steady.
      if (timerEl && timerEl.checked) {
        shootBtn.disabled = true;
        for (var t = 3; t >= 1; t--) {
          if (settled) return;
          if (countdownEl) countdownEl.textContent = String(t);
          await new Promise(function (r) { setTimeout(r, 1000); });
        }
        if (countdownEl) countdownEl.textContent = '';
        shootBtn.disabled = false;
        if (settled) return;
      }

      // The new stream needs a moment after a camera switch; retry briefly
      // instead of dropping the user's click.
      var modeEl = dlg.querySelector('#camMode');
      var mode = modeEl ? modeEl.value : 'plain';
      var url = camGrabFrame(video, mode);
      for (var attempt = 0; !url && attempt < 8; attempt++) {
        await new Promise(function (r) { setTimeout(r, 120); });
        if (settled) return;
        url = camGrabFrame(video, mode);
      }
      if (!url) { camStatus('The camera is not ready yet - press Capture again.', 'err'); return; }
      photos.push({ url: url, taken: Date.now() });
      renderStrip();
      labelDone();
    };

    doneBtn.onclick = function () {
      if (!photos.length) { camStatus('Capture at least one photo first.', 'err'); return; }
      var handEl = dlg.querySelector('#camHand');
      finish({ photos: photos.slice(), handwriting: !!(handEl && handEl.checked) });
    };

    retakeBtn.onclick = function () { photos = []; renderStrip(); labelDone(); };
    cancelBtn.onclick = function () { finish(null); };

    if (selectEl) {
      selectEl.onchange = function () { start(parseInt(this.value, 10) || 0); };
    }

    function finish(value) {
      if (settled) return;
      settled = true;
      stop();
      try { dlg.close(); } catch (e) {}
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      resolve(value);
    }

    // Escape / backdrop close must also release the camera.
    dlg.addEventListener('close', function () {
      if (settled) return;
      settled = true;
      stop();
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      resolve(null);
    });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(null); });

    renderStrip();
    labelDone();
    try { dlg.showModal(); } catch (e) { finish(null); return; }
    start(picked);
  });
}

/* Build the instruction sent alongside the images.
   Handwritten cards need different guidance than printed pages: the model must
   transcribe letterforms rather than guess from context, and must surface what
   it could not read instead of silently normalising it. */
function camBuildPrompt(count, opts) {
  opts = opts || {};
  var handwriting = !!opts.handwriting;
  var lines = [];

  lines.push('These ' + count + ' photo(s) are of ' +
    (handwriting ? 'a HANDWRITTEN recipe card or handwritten recipe notes' : 'a recipe') +
    ', taken in order. They may be several pages of one recipe, or more than one recipe.');

  lines.push('');
  lines.push('Transcribe first, interpret second:');
  lines.push('- Copy ingredient quantities and units exactly as written, including fractions (1/2, 1 1/2), abbreviations (tsp, tbsp, c, g, oz) and ranges (2-3). Do not convert, round, or normalise units.');
  lines.push('- Preserve the written order of ingredients and steps.');
  lines.push('- Keep the writer\'s own words in titles and notes, including informal or misspelled wording.');

  if (handwriting) {
    lines.push('');
    lines.push('This is handwriting, so read it carefully:');
    lines.push('- Read letterforms literally. Do not substitute a more plausible word when a letter is ambiguous.');
    lines.push('- Mark anything you are not confident about inline with [?] immediately after it, e.g. "2[?] cups flour" or "1 tsp salt[?]".');
    lines.push('- For crossed-out or overwritten text, use the replacement if that is clearly intended, and note the abandoned reading in notes.');
    lines.push('- If a whole line is illegible, put "[illegible]" in place of that ingredient or step rather than omitting it.');
    lines.push('- If the card is only partly a recipe (e.g. a shopping scribble or a family note), extract just the recipe parts.');
  } else {
    lines.push('');
    lines.push('Mark anything you cannot read confidently with [?] after it. Use "[illegible]" for a whole line you cannot make out, rather than dropping it.');
  }

  lines.push('');
  lines.push('If there is no recipe in the image at all, return an empty recipes array.');
  return lines.join('\n');
}

/* Handwriting and dense print need a stronger vision model than the app's
   general-purpose default. Only upgrade when the user has not chosen a model
   themselves - never silently override an explicit choice. */
var CAM_VISION_MODEL = 'openai/gpt-4o';

function camAiRecipe(parts) {
  var cfg = aiCfg();
  var explicit = String(cfg.model || '').trim();
  // aiCfg() is seeded with the default model by aiSave(), so treat the default
  // itself as "not explicitly chosen".
  var chosen = (!explicit || explicit === DEFMODEL) ? CAM_VISION_MODEL : explicit;
  if (chosen !== explicit) {
    // Merge rather than replace, so any other stored settings survive.
    try {
      var merged = Object.assign({}, cfg, { model: chosen });
      localStorage.setItem(SKEY, JSON.stringify(merged));
    } catch (e) {}
  }
  return aiRecipe(parts, {});
}

/* Main entry point wired to the #cameraCapture button. */
async function captureRecipeWithCamera() {
  if (!aiCfg().key) {
    camStatus('Add an OpenRouter key in Settings to read photos with AI.', 'err');
    return;
  }
  if (!camHasMediaDevices()) {
    camStatus('This browser cannot open a camera here. Camera access needs https or localhost, and a browser with mediaDevices support.', 'err');
    return;
  }

  var btn = document.getElementById('cameraCapture');
  var oldLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Opening camera…'; }

  try {
    var devices = await camListDevices();
    var result = await camOpenPreview(devices, 0);

    if (btn) { btn.disabled = false; btn.textContent = oldLabel || 'Capture with Camera'; }
    if (!result || !result.photos.length) {
      if (!result) camStatus('Camera closed without capturing photos.');
      return;
    }

    var photos = result.photos;
    if (btn) { btn.disabled = true; btn.textContent = 'Reading photos…'; }
    camStatus('Sending ' + photos.length + ' photo(s) to AI…');

    var parts = [{ type: 'text', text: camBuildPrompt(photos.length, { handwriting: result.handwriting }) }];
    photos.forEach(function (p) { parts.push({ type: 'image_url', image_url: { url: p.url } }); });

    var recipes = await camAiRecipe(parts);
    var paste = document.getElementById('fPaste');
    if (paste) paste.value = '';

    if (recipes && recipes.length) {
      // Prefer the side-by-side review so the transcription can be checked
      // against the card it came from.
      if (typeof reviewImportedWithPhotos === 'function') {
        if (document.getElementById('dImport') && document.getElementById('dImport').open) {
          try { document.getElementById('dImport').close(); } catch (e) {}
        }
        camStatus('Read ' + recipes.length + ' recipe(s) from ' + photos.length + ' photo(s). Check them against the photo.', 'ok');
        await reviewImportedWithPhotos(recipes, photos);
        return;
      }
      reviewImported(recipes);
    } else {
      camStatus('No recipe found in those photos. Retake with better lighting or use paste import.', 'err');
    }
  } catch (e) {
    camStatus(e.message || String(e), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldLabel || 'Capture with Camera'; }
  }
}

function initCameraUI() {
  var btn = document.getElementById('cameraCapture');
  if (btn) btn.onclick = captureRecipeWithCamera;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCameraUI);
else initCameraUI();