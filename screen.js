/**
 * LUFS Meter — screen.js  v1.5.0
 *
 * Gain chain:  <audio> → MediaElementSourceNode → GainNode → AnalyserNode → destination
 * Total gain = manifestOffsetDb + userTrimDb
 *
 * Key API facts confirmed from server.py + v0.2.8 release notes:
 *
 *   - The WS message type is "song_info" (server.py:4763), but `filename` is NOT
 *     in that payload — it lives in the WS URL /ws/highway/{filename}.
 *     The frontend re-emits as window.slopsmith.emit('song:play', {...}) and
 *     DOES include filename in that event payload.
 *     → We listen to 'song:play', not 'song:info'.
 *
 *   - highway.getAudioElement() is the correct v0.2.8 API for the audio element.
 *     document.getElementById('audio') is a fragile fallback.
 *
 *   - window.playSong wrapping: await inside a plugin wrapper yields to the event
 *     loop, so WS messages can arrive before outer wrappers finish. We must not
 *     depend on setup order — instead we set up the audio graph lazily on the
 *     first 'song:play' event and also on any showScreen call.
 *
 *   - esc() is the correct function to return to the player screen from a plugin.
 *     showScreen() navigates forward; esc() goes back. We add a back button.
 *
 *   - Tailwind: prebuilt stylesheet replaced the Play CDN. We use 100% inline
 *     styles throughout — no change needed.
 *
 *   - window.slopsmith.on() is the correct event subscription API.
 *     (Not window.addEventListener, not a custom EventEmitter pattern.)
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Settings — persisted to localStorage
  // -------------------------------------------------------------------------
  const SETTINGS_KEY = 'lufs_meter_v2';

  function _loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (_) { return {}; }
  }
  function _saveSettings(patch) {
    const s = _loadSettings();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, ...patch }));
  }
  function _getGlobalEnabled() { return !!_loadSettings().globalEnabled; }
  function _getGlobalTarget()  {
    const v = _loadSettings().globalTarget;
    return typeof v === 'number' ? v : -16.0;
  }
  function _getTrimEntry(fn) {
    const s = _loadSettings();
    return (s.trims && s.trims[fn]) ? s.trims[fn] : null;
  }
  function _setTrimEntry(fn, db, provisional) {
    const s = _loadSettings();
    s.trims = s.trims || {};
    s.trims[fn] = { db, provisional: !!provisional };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  let _audioCtx   = null;
  let _sourceNode = null;
  let _gainNode   = null;
  let _analyser   = null;
  let _pcmBuffer  = null;
  let _rafId      = null;
  let _lastMeasure = 0;

  let _currentFilename   = null;
  let _currentFormat     = 'unknown';
  let _currentAudioUrl   = null;
  let _manifestOffsetDb  = 0.0;
  let _userTrimDb        = 0.0;
  let _trimIsProvisional = false;
  let _audioGraphReady   = false;

  let _momentaryLufs  = null;
  let _shortTermLufs  = null;
  let _lufsBuffer     = [];

  let _integratedSamples  = [];
  let _activeAudioSeconds = 0;
  let _refinementDone     = false;
  let _refinementTimer    = null;

  const MEASURE_MS         = 400;
  const SHORT_TERM_MS      = 3000;
  const REFINEMENT_AFTER_S = 60;
  const SILENCE_THRESHOLD  = -50;
  const PREFLIGHT_BYTES    = 400_000;
  const PREFLIGHT_START_PCT = 0.30;

  // -------------------------------------------------------------------------
  // Get the audio element via the official API with fallback
  // -------------------------------------------------------------------------
  function _getAudioElement() {
    // v0.2.8+: highway.getAudioElement() is the correct API
    try {
      if (window.highway && typeof window.highway.getAudioElement === 'function') {
        return window.highway.getAudioElement();
      }
    } catch (_) {}
    // Fallback for older versions
    return document.getElementById('audio');
  }

  // -------------------------------------------------------------------------
  // Web Audio graph — set up lazily, idempotent
  // -------------------------------------------------------------------------
  function _setupAudioGraph() {
    const audioEl = _getAudioElement();
    if (!audioEl) return false;

    if (!_audioCtx) {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_audioCtx.state === 'suspended') _audioCtx.resume();

    // If we already have a source node connected to this same element, reuse it
    if (_audioGraphReady && _gainNode) {
      _applyGain();
      return true;
    }

    try { _sourceNode && _sourceNode.disconnect(); } catch (_) {}
    try { _gainNode   && _gainNode.disconnect();   } catch (_) {}
    try { _analyser   && _analyser.disconnect();   } catch (_) {}

    try {
      _sourceNode = _audioCtx.createMediaElementSource(audioEl);
    } catch (e) {
      // Already captured — this element's source node persists across songs.
      // Reconnect our gain and analyser to the existing source.
      if (!_sourceNode) {
        console.warn('[lufs_meter] Cannot create MediaElementSource:', e);
        return false;
      }
    }

    _gainNode  = _audioCtx.createGain();
    _analyser  = _audioCtx.createAnalyser();
    _analyser.fftSize = 2048;
    _analyser.smoothingTimeConstant = 0.0;
    _pcmBuffer = new Float32Array(_analyser.fftSize);

    _sourceNode.connect(_gainNode);
    _gainNode.connect(_analyser);
    _analyser.connect(_audioCtx.destination);

    _audioGraphReady = true;
    _applyGain();
    return true;
  }

  // -------------------------------------------------------------------------
  // Gain
  // -------------------------------------------------------------------------
  function _applyGain() {
    if (!_gainNode) return;
    const db = Math.max(-40, Math.min(20, _manifestOffsetDb + _userTrimDb));
    _gainNode.gain.value = Math.pow(10, db / 20);
  }

  function _setUserTrim(db, provisional = false) {
    _userTrimDb        = Math.max(-20, Math.min(20, db));
    _trimIsProvisional = provisional;
    _applyGain();
    _updateInfoPanel();
    if (_currentFilename) {
      _setTrimEntry(_currentFilename, _userTrimDb, provisional);
      fetch('/api/plugins/lufs_meter/set_offset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: _currentFilename, offset_db: _userTrimDb })
      }).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // LUFS helpers
  // -------------------------------------------------------------------------
  function _rmsToLufs(rms) {
    if (rms < 1e-9) return -Infinity;
    return 20 * Math.log10(rms) - 0.691;
  }
  function _integratedLufs() {
    if (_integratedSamples.length === 0) return null;
    const meanSq = _integratedSamples.reduce((s, r) => s + r * r, 0) / _integratedSamples.length;
    return _rmsToLufs(Math.sqrt(meanSq));
  }

  // -------------------------------------------------------------------------
  // Live meter tick
  // -------------------------------------------------------------------------
  function _measureTick() {
    _rafId = requestAnimationFrame(_measureTick);
    const now = performance.now();
    if (now - _lastMeasure < MEASURE_MS) return;
    _lastMeasure = now;

    if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume();
    if (!_analyser || !_pcmBuffer) return;

    _analyser.getFloatTimeDomainData(_pcmBuffer);
    let sumSq = 0;
    for (let i = 0; i < _pcmBuffer.length; i++) sumSq += _pcmBuffer[i] * _pcmBuffer[i];
    const rms = Math.sqrt(sumSq / _pcmBuffer.length);
    _momentaryLufs = _rmsToLufs(rms);

    _lufsBuffer.push({ t: now, lufs: _momentaryLufs });
    _lufsBuffer = _lufsBuffer.filter(e => now - e.t <= SHORT_TERM_MS);
    if (_lufsBuffer.length > 0)
      _shortTermLufs = _lufsBuffer.reduce((s, e) => s + e.lufs, 0) / _lufsBuffer.length;

    const audioEl = _getAudioElement();
    if (audioEl && !audioEl.paused && _momentaryLufs > SILENCE_THRESHOLD) {
      _integratedSamples.push(rms);
      _activeAudioSeconds += MEASURE_MS / 1000;
      if (!_refinementDone && _trimIsProvisional && _activeAudioSeconds >= REFINEMENT_AFTER_S)
        _refineFromIntegrated();
    }

    _updateMeterDisplay();
  }

  // -------------------------------------------------------------------------
  // Refinement
  // -------------------------------------------------------------------------
  function _refineFromIntegrated() {
    const intLufs = _integratedLufs();
    if (!isFinite(intLufs)) return;
    const delta = _getGlobalTarget() - intLufs;
    _refinementDone = true;
    _setUserTrim(_userTrimDb + delta, false);
    _showRefinementBadge(intLufs.toFixed(1));
    console.log(`[lufs_meter] refined: ${intLufs.toFixed(1)} LUFS, delta ${delta.toFixed(2)} dB`);
  }

  function _onAudioEnded() {
    if (!_refinementDone && _trimIsProvisional && _integratedSamples.length > 10)
      _refineFromIntegrated();
  }

  // -------------------------------------------------------------------------
  // Preflight byte-range sample
  // -------------------------------------------------------------------------
  async function _sampleAudioUrl(audioUrl) {
    if (!audioUrl) return null;
    try {
      const head = await fetch(audioUrl, { method: 'HEAD' });
      const contentLength = parseInt(head.headers.get('content-length') || '0', 10);
      if (!contentLength || contentLength < 50_000) return null;

      const start = Math.floor(contentLength * PREFLIGHT_START_PCT);
      const end   = Math.min(start + PREFLIGHT_BYTES, contentLength - 1);
      const resp  = await fetch(audioUrl, { headers: { Range: `bytes=${start}-${end}` } });
      if (!resp.ok && resp.status !== 206) return null;

      const arrayBuf = await resp.arrayBuffer();
      if (!arrayBuf || arrayBuf.byteLength < 4096) return null;

      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
      let decoded;
      try { decoded = await ctx.decodeAudioData(arrayBuf); }
      catch (_) { await ctx.close(); return null; }
      await ctx.close();

      let sumSq = 0, total = 0;
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const data = decoded.getChannelData(ch);
        for (let i = 0; i < data.length; i++) { sumSq += data[i] * data[i]; total++; }
      }
      return total > 0 ? _rmsToLufs(Math.sqrt(sumSq / total)) : null;
    } catch (e) {
      console.warn('[lufs_meter] preflight failed:', e);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Background analysis queue
  // -------------------------------------------------------------------------
  const _analysisCache   = new Map();
  const _analysisInFlight = new Set();
  const _analysisQueue   = [];
  let _activeAnalyses    = 0;
  const MAX_CONCURRENT   = 2;

  function _queueAnalysis(filename, audioUrl) {
    if (!_getGlobalEnabled()) return;
    if (!audioUrl || !filename) return;
    if (_analysisCache.has(filename)) return;
    if (_getTrimEntry(filename) && !_getTrimEntry(filename).provisional) return;
    if (_analysisInFlight.has(filename)) return;
    if (_analysisQueue.some(e => e.filename === filename)) return;
    _analysisQueue.push({ filename, audioUrl });
    _drainQueue();
  }

  function _drainQueue() {
    while (_activeAnalyses < MAX_CONCURRENT && _analysisQueue.length > 0) {
      const { filename, audioUrl } = _analysisQueue.shift();
      _runAnalysis(filename, audioUrl);
    }
  }

  async function _runAnalysis(filename, audioUrl) {
    _analysisInFlight.add(filename);
    _activeAnalyses++;
    try {
      const lufs = await _sampleAudioUrl(audioUrl);
      if (lufs !== null && isFinite(lufs)) {
        _analysisCache.set(filename, { lufs, analysedAt: Date.now() });
        console.log(`[lufs_meter] bg: ${filename} → ${lufs.toFixed(1)} LUFS`);
        if (filename === _currentFilename && _trimIsProvisional) {
          _setUserTrim(_getGlobalTarget() - lufs - _manifestOffsetDb, true);
        }
      }
    } finally {
      _analysisInFlight.delete(filename);
      _activeAnalyses--;
      _drainQueue();
    }
  }

  function _scheduleIdleDrain() {
    if ('requestIdleCallback' in window)
      requestIdleCallback(() => { if (_analysisQueue.length > 0) _drainQueue(); }, { timeout: 5000 });
  }

  // -------------------------------------------------------------------------
  // Library card hover → queue analysis
  // -------------------------------------------------------------------------
  function _hookLibraryCards() {
    const container = document.getElementById('library') || document.body;
    container.addEventListener('mouseenter', _onCardHover, { capture: true, passive: true });
    container.addEventListener('focusin',    _onCardHover, { capture: true, passive: true });
  }

  function _onCardHover(evt) {
    if (!_getGlobalEnabled()) return;
    let el = evt.target, filename = null;
    for (let i = 0; i < 6 && el && el !== document.body; i++) {
      filename = el.dataset && (el.dataset.filename || el.dataset.file);
      if (filename) break;
      el = el.parentElement;
    }
    if (filename) _pendingFilenames.add(filename);
    _scheduleIdleDrain();
  }

  const _pendingFilenames = new Set();

  // -------------------------------------------------------------------------
  // Song-preview plugin hook
  // -------------------------------------------------------------------------
  function _hookSongPreview() {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeName === 'AUDIO' && node !== _getAudioElement()) {
            node.addEventListener('loadstart', () => {
              if (node.src) _onPreviewUrl(node.src, node.dataset && node.dataset.filename);
            });
          }
        }
        if (m.type === 'attributes' && m.attributeName === 'src') {
          const el = m.target;
          if (el.nodeName === 'AUDIO' && el !== _getAudioElement() && el.src)
            _onPreviewUrl(el.src, el.dataset && el.dataset.filename);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

    window.addEventListener('song-preview:play', (evt) => {
      const { filename, audioUrl } = evt.detail || {};
      if (filename && audioUrl) _queueAnalysis(filename, audioUrl);
    });
  }

  function _onPreviewUrl(url, filenameHint) {
    if (!url || !_getGlobalEnabled()) return;
    if (filenameHint) { _queueAnalysis(filenameHint, url); return; }
    for (const fn of _pendingFilenames) {
      const stem = fn.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 10).toLowerCase();
      if (url.toLowerCase().includes(stem)) {
        _queueAnalysis(fn, url);
        _pendingFilenames.delete(fn);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Song lifecycle — triggered by song:play event
  // -------------------------------------------------------------------------
  async function _onSongPlay(info) {
    // info from window.slopsmith 'song:play' event includes:
    //   filename, format, audio_url, duration, title, artist, arrangement, ...
    const filename = info.filename;
    const format   = info.format   || 'unknown';
    const audioUrl = info.audio_url || null;

    if (!filename) return;

    if (_refinementTimer) { clearTimeout(_refinementTimer); _refinementTimer = null; }

    _currentFilename    = filename;
    _currentFormat      = format;
    _currentAudioUrl    = audioUrl;
    _manifestOffsetDb   = 0.0;
    _momentaryLufs      = null;
    _shortTermLufs      = null;
    _lufsBuffer         = [];
    _integratedSamples  = [];
    _activeAudioSeconds = 0;
    _refinementDone     = false;
    _trimIsProvisional  = false;

    // Ensure audio graph is connected — do this every song load
    // because the highway may have rebuilt the audio element
    _audioGraphReady = false;
    _setupAudioGraph();

    const audioEl = _getAudioElement();
    if (audioEl) {
      audioEl.removeEventListener('ended', _onAudioEnded);
      audioEl.addEventListener('ended', _onAudioEnded, { once: true });
    }

    // Fetch PSARC SongVolume from backend
    try {
      const r = await fetch(`/api/plugins/lufs_meter/song_volume?filename=${encodeURIComponent(filename)}`);
      const d = await r.json();
      _manifestOffsetDb = typeof d.volume_db === 'number' ? d.volume_db : 0.0;
      if (d.format) _currentFormat = d.format;
    } catch (_) {}

    // Check for saved trim (server DB first, localStorage fallback)
    let savedTrim = null;
    try {
      const r = await fetch(`/api/plugins/lufs_meter/get_offset?filename=${encodeURIComponent(filename)}`);
      const d = await r.json();
      if (typeof d.offset_db === 'number' && d.offset_db !== 0.0) savedTrim = d.offset_db;
    } catch (_) {}
    const localEntry = _getTrimEntry(filename);
    if (savedTrim === null && localEntry) savedTrim = localEntry.db;

    if (savedTrim !== null) {
      _userTrimDb        = savedTrim;
      _trimIsProvisional = localEntry ? !!localEntry.provisional : false;
      _applyGain();
      _updateInfoPanel();
      return;
    }

    if (!_getGlobalEnabled()) {
      _userTrimDb = 0.0;
      _applyGain();
      _updateInfoPanel();
      return;
    }

    // Check background analysis cache
    const cached = _analysisCache.get(filename);
    if (cached && isFinite(cached.lufs)) {
      const trim = _getGlobalTarget() - cached.lufs - _manifestOffsetDb;
      _setUserTrim(trim, true);
      _updatePreflightStatus(`pre-analysed: ${cached.lufs.toFixed(1)} LUFS → ${_fmtDb(trim)}`);
      _analysisCache.delete(filename);
      return;
    }

    // Preflight: sample the audio file now
    if (audioUrl) {
      _updatePreflightStatus('sampling…');
      const lufs = await _sampleAudioUrl(audioUrl);
      if (lufs !== null && isFinite(lufs)) {
        const trim = _getGlobalTarget() - lufs - _manifestOffsetDb;
        _setUserTrim(trim, true);
        _updatePreflightStatus(`sampled: ${lufs.toFixed(1)} LUFS → ${_fmtDb(trim)}`);
        return;
      }
    }

    // Fallback: no trim yet, refine from live meter after 8 s
    _userTrimDb = 0.0;
    _applyGain();
    _updatePreflightStatus('sampling failed — refining from live meter');
    _refinementTimer = setTimeout(() => {
      if (!_refinementDone && isFinite(_shortTermLufs)) {
        _setUserTrim(_getGlobalTarget() - _shortTermLufs, true);
        _refinementDone = false;
      }
    }, 8000);
  }

  // -------------------------------------------------------------------------
  // Display helpers
  // -------------------------------------------------------------------------
  function _fmt(val)   { return (!val || !isFinite(val)) ? '–' : val.toFixed(1) + ' LUFS'; }
  function _fmtDb(val) {
    if (val === null || !isFinite(val)) return '0.0 dB';
    return (val >= 0 ? '+' : '') + val.toFixed(1) + ' dB';
  }
  function _colorForLufs(lufs) {
    if (!isFinite(lufs)) return '#6b7280';
    const t = _getGlobalEnabled() ? _getGlobalTarget() : -16.0;
    if (lufs > t + 6) return '#ef4444';
    if (lufs > t + 2) return '#f59e0b';
    if (lufs > t - 2) return '#22c55e';
    return '#60a5fa';
  }

  function _updateMeterDisplay() {
    const mEl = document.getElementById('lm-momentary');
    const sEl = document.getElementById('lm-short-term');
    const bar  = document.getElementById('lm-bar');
    const tgt  = document.getElementById('lm-target-line');
    if (mEl) { mEl.textContent = _fmt(_momentaryLufs);  mEl.style.color = _colorForLufs(_momentaryLufs); }
    if (sEl) { sEl.textContent = _fmt(_shortTermLufs);  sEl.style.color = _colorForLufs(_shortTermLufs); }
    if (bar && isFinite(_momentaryLufs)) {
      const pct = Math.max(0, Math.min(100, ((_momentaryLufs + 40) / 34) * 100));
      bar.style.width = pct + '%';
      bar.style.background = _colorForLufs(_momentaryLufs);
    }
    if (tgt) {
      const t = _getGlobalEnabled() ? _getGlobalTarget() : -16.0;
      tgt.style.left    = Math.max(0, Math.min(100, ((t + 40) / 34) * 100)) + '%';
      tgt.style.display = 'block';
    }
  }

  function _updateInfoPanel() {
    const set = (id, text, color) => {
      const el = document.getElementById(id);
      if (el) { el.textContent = text; if (color) el.style.color = color; }
    };
    set('lm-format',          _currentFormat || '–');
    set('lm-manifest-offset', _fmtDb(_manifestOffsetDb),
        _manifestOffsetDb !== 0 ? '#22c55e' : '#6b7280');
    set('lm-user-trim',       _fmtDb(_userTrimDb));
    set('lm-total-offset',    _fmtDb(_manifestOffsetDb + _userTrimDb));

    const tIn  = document.getElementById('lm-trim-input');
    if (tIn)   tIn.value = _userTrimDb.toFixed(1);

    const prov = document.getElementById('lm-provisional-badge');
    if (prov) {
      prov.style.display = _trimIsProvisional ? 'inline' : 'none';
      prov.textContent   = _trimIsProvisional ? '⏳ provisional — refining…' : '';
    }
    const ovEl = document.getElementById('lm-override-status');
    if (ovEl) {
      ovEl.textContent = _getGlobalEnabled()
        ? `Global override ON → ${_getGlobalTarget().toFixed(1)} LUFS` : 'Global override off';
      ovEl.style.color = _getGlobalEnabled() ? '#e8c040' : '#4b5563';
    }
    const qEl = document.getElementById('lm-queue-size');
    if (qEl) {
      const n = _analysisQueue.length + _activeAnalyses;
      qEl.textContent = n > 0 ? `${n} queued` : `${_analysisCache.size} pre-analysed`;
      qEl.style.color = n > 0 ? '#e8c040' : '#4b5563';
    }
  }

  function _updateOverrideUI() {
    const toggle   = document.getElementById('lm-override-toggle');
    const targetEl = document.getElementById('lm-override-target');
    const row      = document.getElementById('lm-override-controls');
    if (toggle)   toggle.checked = _getGlobalEnabled();
    if (targetEl) targetEl.value = _getGlobalTarget().toFixed(1);
    if (row)      row.style.opacity = _getGlobalEnabled() ? '1' : '0.4';
    _updateInfoPanel();
    _updateMeterDisplay();
  }

  function _updatePreflightStatus(msg) {
    const el = document.getElementById('lm-preflight-status');
    if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; el.style.color = '#9ca3af'; }
  }

  function _showRefinementBadge(lufs) {
    const el = document.getElementById('lm-preflight-status');
    if (el) { el.textContent = `✓ refined: ${lufs} LUFS integrated`; el.style.color = '#22c55e'; el.style.display = 'block'; }
    const p = document.getElementById('lm-provisional-badge');
    if (p)   p.style.display = 'none';
  }

  // -------------------------------------------------------------------------
  // Player navbar widget injection
  // -------------------------------------------------------------------------
  function _injectPlayerWidget() {
    if (document.getElementById('lm-player-widget')) return;
    const controls = document.getElementById('player-controls');
    if (!controls) return;

    const w = document.createElement('div');
    w.id = 'lm-player-widget';
    w.title = 'LUFS Meter — click for details';
    w.style.cssText = `display:flex;align-items:center;gap:6px;padding:0 8px;
      font-size:12px;font-family:ui-monospace,monospace;color:#9ca3af;
      border-left:1px solid #374151;min-width:120px;cursor:pointer;user-select:none;`;
    w.innerHTML = `
      <span id="lm-momentary" style="font-size:13px;font-weight:600;color:#6b7280;min-width:82px;">– LUFS</span>
      <span style="position:relative;width:44px;height:6px;background:#1f2937;border-radius:3px;
        overflow:visible;flex-shrink:0;display:inline-block;">
        <span style="position:absolute;inset:0;overflow:hidden;border-radius:3px;">
          <span id="lm-bar" style="display:block;height:100%;width:0%;border-radius:3px;
            transition:width .4s,background .4s;"></span>
        </span>
        <span id="lm-target-line" style="display:none;position:absolute;top:-2px;bottom:-2px;width:2px;
          background:#e8c040;border-radius:1px;transform:translateX(-50%);pointer-events:none;"></span>
      </span>
    `;
    w.addEventListener('click', () => {
      // Save which screen we're on so esc() can return to it
      _callerScreen = document.querySelector('.screen.active')?.id || null;
      window.showScreen && window.showScreen('plugin-lufs_meter');
    });
    controls.appendChild(w);
  }

  let _callerScreen = null;

  new MutationObserver(() => {
    if (document.getElementById('player-controls')) _injectPlayerWidget();
  }).observe(document.body, { childList: true, subtree: true });
  _injectPlayerWidget();

  // -------------------------------------------------------------------------
  // Screen init — called each time the plugin screen becomes visible
  // -------------------------------------------------------------------------
  window._lufs_meter_init_screen = function () {
    // Ensure audio graph is connected whenever the screen opens
    // (covers the case where user opens LUFS Meter mid-song)
    if (!_audioGraphReady) _setupAudioGraph();

    // Back button — esc() returns to the previous screen (the player)
    document.getElementById('lm-btn-back')?.addEventListener('click', () => {
      if (typeof esc === 'function') esc();
    });

    document.getElementById('lm-btn-minus')?.addEventListener('click', () => _setUserTrim(_userTrimDb - 0.5));
    document.getElementById('lm-btn-plus')?.addEventListener('click',  () => _setUserTrim(_userTrimDb + 0.5));
    document.getElementById('lm-btn-reset')?.addEventListener('click', () => {
      _setUserTrim(0, false);
      _trimIsProvisional = false;
      _updatePreflightStatus('');
    });
    document.getElementById('lm-trim-input')?.addEventListener('change', function () {
      const v = parseFloat(this.value);
      if (!isNaN(v)) _setUserTrim(v, false);
    });
    document.getElementById('lm-btn-normalise')?.addEventListener('click', () => {
      const ref = _shortTermLufs ?? _momentaryLufs;
      if (!isFinite(ref)) return;
      const t = parseFloat(document.getElementById('lm-override-target')?.value || _getGlobalTarget());
      _setUserTrim(_userTrimDb + (t - ref), false);
    });
    document.getElementById('lm-btn-remeasure')?.addEventListener('click', async () => {
      if (!_currentAudioUrl) return;
      _updatePreflightStatus('sampling…');
      const lufs = await _sampleAudioUrl(_currentAudioUrl);
      if (lufs !== null && isFinite(lufs)) {
        _setUserTrim(_getGlobalTarget() - lufs - _manifestOffsetDb, false);
        _updatePreflightStatus(`sampled: ${lufs.toFixed(1)} LUFS → ${_fmtDb(_userTrimDb)}`);
      } else {
        _updatePreflightStatus('sample decode failed');
      }
    });

    document.getElementById('lm-override-toggle')?.addEventListener('change', function () {
      _saveSettings({ globalEnabled: this.checked });
      _updateOverrideUI();
    });
    document.getElementById('lm-override-target')?.addEventListener('change', function () {
      const v = parseFloat(this.value);
      if (!isNaN(v)) { _saveSettings({ globalTarget: v }); _updateOverrideUI(); }
    });
    document.querySelectorAll('[data-lufs-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = parseFloat(btn.dataset.lufsPreset);
        if (!isNaN(v)) { _saveSettings({ globalTarget: v, globalEnabled: true }); _updateOverrideUI(); }
      });
    });

    if (!_rafId) { _lastMeasure = 0; _rafId = requestAnimationFrame(_measureTick); }
    _updateOverrideUI();
    _updateInfoPanel();
    _updateMeterDisplay();
    _updatePreflightStatus('');
  };

  // -------------------------------------------------------------------------
  // Slopsmith event hooks
  // -------------------------------------------------------------------------

  // song:play is the correct event — fired by the frontend after the WS
  // song_info message is processed. Payload includes filename, audio_url, format.
  window.slopsmith?.on('song:play', (info) => {
    _onSongPlay(info || {});
  });

  // Also hook playSong to ensure audio graph is set up promptly
  // (song:play may fire slightly after audio starts in some versions)
  const _origPlaySong = window.playSong;
  if (typeof _origPlaySong === 'function') {
    window.playSong = async function (song, options) {
      const result = await _origPlaySong.call(this, song, options);
      // Attempt graph setup; if it fails here song:play will retry
      _setupAudioGraph();
      return result;
    };
  }

  // Start background hooks
  _hookLibraryCards();
  _hookSongPreview();

  // Start meter loop immediately so navbar widget is live
  _lastMeasure = 0;
  _rafId = requestAnimationFrame(_measureTick);

  // If a song is already playing when we load (e.g. plugin installed mid-session),
  // try to connect to the existing audio element now
  _setupAudioGraph();

})();
