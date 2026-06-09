/**
 * LUFS Meter — screen.js  v1.6.2
 *
 * Architecture change from v1.5.x:
 *   The plugin no longer navigates away from the player to show live metering.
 *   Instead, clicking the player bar widget toggles a FLOATING SIDE PANEL
 *   injected directly into document.body. The panel overlays the highway,
 *   playback continues uninterrupted, and a ✕ button closes it.
 *
 *   The plugin screen (screen.html / nav link) still exists for settings —
 *   global target, presets, manual trim — but the live meter lives in the panel.
 *
 * Gain chain:  <audio> → MediaElementSourceNode → GainNode → AnalyserNode → destination
 * Total gain = manifestOffsetDb + userTrimDb
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  const SETTINGS_KEY = 'lufs_meter_v2';
  const VERSION = '1.6.2';

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
  let _audioGraphReady = false;

  let _currentFilename   = null;
  let _currentFormat     = 'unknown';
  let _currentAudioUrl   = null;
  let _manifestOffsetDb  = 0.0;
  let _userTrimDb        = 0.0;
  let _trimIsProvisional = false;

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

  // Create AudioContext eagerly — constructing it later causes a brief audio
  // interruption in Electron/Desktop when a song is already playing.
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    console.warn('[lufs_meter] AudioContext creation failed:', e);
  }

  // -------------------------------------------------------------------------
  // Audio element helper
  // -------------------------------------------------------------------------
  function _getAudioElement() {
    try {
      if (window.highway && typeof window.highway.getAudioElement === 'function')
        return window.highway.getAudioElement();
    } catch (_) {}
    return document.getElementById('audio');
  }

  // -------------------------------------------------------------------------
  // Web Audio graph — built once, never torn down while playing
  // -------------------------------------------------------------------------
  function _setupAudioGraph() {
    const audioEl = _getAudioElement();
    if (!audioEl || !_audioCtx) return false;

    if (_audioCtx.state === 'suspended') _audioCtx.resume();

    // Already connected — just reapply gain
    if (_audioGraphReady && _gainNode) {
      _applyGain();
      return true;
    }

    // Never rebuild while audio is playing — it causes a pause
    const _playCheck = _getAudioElement();
    if (_playCheck && !_playCheck.paused && _sourceNode) {
      _applyGain();
      return false;
    }

    try { _sourceNode && _sourceNode.disconnect(); } catch (_) {}
    try { _gainNode   && _gainNode.disconnect();   } catch (_) {}
    try { _analyser   && _analyser.disconnect();   } catch (_) {}

    try {
      _sourceNode = _audioCtx.createMediaElementSource(audioEl);
    } catch (e) {
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
    _updateAllDisplays();
    if (_currentFilename) {
      _setTrimEntry(_currentFilename, _userTrimDb, provisional);
      fetch('/api/plugins/lufs-meter/set_offset', {
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

    _updateMeterDisplays();
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
    _setPanelStatus(`✓ refined: ${intLufs.toFixed(1)} LUFS`, '#22c55e');
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
  const _analysisCache    = new Map();
  const _analysisInFlight = new Set();
  const _analysisQueue    = [];
  let _activeAnalyses     = 0;
  const MAX_CONCURRENT    = 2;
  const _pendingFilenames = new Set();

  function _queueAnalysis(filename, audioUrl) {
    if (!_getGlobalEnabled() || !audioUrl || !filename) return;
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
        if (filename === _currentFilename && _trimIsProvisional)
          _setUserTrim(_getGlobalTarget() - lufs - _manifestOffsetDb, true);
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
  // Library card hover / song-preview hooks
  // -------------------------------------------------------------------------
  function _hookLibraryCards() {
    const container = document.getElementById('library') || document.body;
    const handler = (evt) => {
      if (!_getGlobalEnabled()) return;
      let el = evt.target, filename = null;
      for (let i = 0; i < 6 && el && el !== document.body; i++) {
        filename = el.dataset && (el.dataset.filename || el.dataset.file);
        if (filename) break;
        el = el.parentElement;
      }
      if (filename) { _pendingFilenames.add(filename); _scheduleIdleDrain(); }
    };
    container.addEventListener('mouseenter', handler, { capture: true, passive: true });
    container.addEventListener('focusin',    handler, { capture: true, passive: true });
  }

  function _hookSongPreview() {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeName === 'AUDIO' && node !== _getAudioElement()) {
            node.addEventListener('loadstart', () => {
              if (node.src) _onPreviewUrl(node.src, node.dataset?.filename);
            });
          }
        }
        if (m.type === 'attributes' && m.attributeName === 'src') {
          const el = m.target;
          if (el.nodeName === 'AUDIO' && el !== _getAudioElement() && el.src)
            _onPreviewUrl(el.src, el.dataset?.filename);
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
  // Song lifecycle
  // -------------------------------------------------------------------------
  async function _onSongPlay(info) {
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

    _setupAudioGraph();

    const audioEl = _getAudioElement();
    if (audioEl) {
      audioEl.removeEventListener('ended', _onAudioEnded);
      audioEl.addEventListener('ended', _onAudioEnded, { once: true });
    }

    try {
      const r = await fetch(`/api/plugins/lufs-meter/song_volume?filename=${encodeURIComponent(filename)}`);
      const d = await r.json();
      _manifestOffsetDb = typeof d.volume_db === 'number' ? d.volume_db : 0.0;
      if (d.format) _currentFormat = d.format;
    } catch (_) {}

    let savedTrim = null;
    try {
      const r = await fetch(`/api/plugins/lufs-meter/get_offset?filename=${encodeURIComponent(filename)}`);
      const d = await r.json();
      if (typeof d.offset_db === 'number' && d.offset_db !== 0.0) savedTrim = d.offset_db;
    } catch (_) {}
    const localEntry = _getTrimEntry(filename);
    if (savedTrim === null && localEntry) savedTrim = localEntry.db;

    if (savedTrim !== null) {
      _userTrimDb        = savedTrim;
      _trimIsProvisional = localEntry ? !!localEntry.provisional : false;
      _applyGain();
      _updateAllDisplays();
      return;
    }

    if (!_getGlobalEnabled()) {
      _userTrimDb = 0.0;
      _applyGain();
      _updateAllDisplays();
      return;
    }

    const cached = _analysisCache.get(filename);
    if (cached && isFinite(cached.lufs)) {
      const trim = _getGlobalTarget() - cached.lufs - _manifestOffsetDb;
      _setUserTrim(trim, true);
      _setPanelStatus(`pre-analysed: ${cached.lufs.toFixed(1)} LUFS → ${_fmtDb(trim)}`, '#9ca3af');
      _analysisCache.delete(filename);
      return;
    }

    if (audioUrl) {
      _setPanelStatus('sampling…', '#9ca3af');
      const lufs = await _sampleAudioUrl(audioUrl);
      if (lufs !== null && isFinite(lufs)) {
        const trim = _getGlobalTarget() - lufs - _manifestOffsetDb;
        _setUserTrim(trim, true);
        _setPanelStatus(`sampled: ${lufs.toFixed(1)} LUFS → ${_fmtDb(trim)}`, '#9ca3af');
        return;
      }
    }

    _userTrimDb = 0.0;
    _applyGain();
    _setPanelStatus('sampling failed — refining from live meter', '#f59e0b');
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

  // Update both the floating panel and the plugin screen (whichever is visible)
  function _updateMeterDisplays() {
    const color = _colorForLufs(_momentaryLufs);
    for (const id of ['lm-momentary', 'lm-panel-momentary']) {
      const el = document.getElementById(id);
      if (el) { el.textContent = _fmt(_momentaryLufs); el.style.color = color; }
    }
    for (const id of ['lm-short-term', 'lm-panel-short-term']) {
      const el = document.getElementById(id);
      if (el) { el.textContent = _fmt(_shortTermLufs); el.style.color = _colorForLufs(_shortTermLufs); }
    }
    for (const id of ['lm-bar', 'lm-panel-bar']) {
      const el = document.getElementById(id);
      if (el && isFinite(_momentaryLufs)) {
        const pct = Math.max(0, Math.min(100, ((_momentaryLufs + 40) / 34) * 100));
        el.style.width = pct + '%';
        el.style.background = color;
      }
    }
    for (const id of ['lm-target-line', 'lm-panel-target-line']) {
      const el = document.getElementById(id);
      if (el) {
        const t = _getGlobalEnabled() ? _getGlobalTarget() : -16.0;
        el.style.left    = Math.max(0, Math.min(100, ((t + 40) / 34) * 100)) + '%';
        el.style.display = 'block';
      }
    }
  }

  function _updateAllDisplays() {
    _updateMeterDisplays();
    // Update panel gain info
    const set = (id, text, col) => { const el = document.getElementById(id); if (el) { el.textContent = text; if (col) el.style.color = col; } };
    set('lm-panel-manifest',   _fmtDb(_manifestOffsetDb), _manifestOffsetDb !== 0 ? '#22c55e' : '#6b7280');
    set('lm-panel-trim',       _fmtDb(_userTrimDb));
    set('lm-panel-total',      _fmtDb(_manifestOffsetDb + _userTrimDb));
    set('lm-panel-format',     _currentFormat || '–');
    const trimIn = document.getElementById('lm-panel-trim-input');
    if (trimIn) trimIn.value = _userTrimDb.toFixed(1);
    const prov = document.getElementById('lm-panel-provisional');
    if (prov) { prov.style.display = _trimIsProvisional ? 'inline' : 'none'; }
    // Also update settings screen elements if visible
    set('lm-manifest-offset',  _fmtDb(_manifestOffsetDb), _manifestOffsetDb !== 0 ? '#22c55e' : '#6b7280');
    set('lm-user-trim',        _fmtDb(_userTrimDb));
    set('lm-total-offset',     _fmtDb(_manifestOffsetDb + _userTrimDb));
    set('lm-format',           _currentFormat || '–');
    const trimIn2 = document.getElementById('lm-trim-input');
    if (trimIn2) trimIn2.value = _userTrimDb.toFixed(1);
    const qEl = document.getElementById('lm-queue-size');
    if (qEl) {
      const n = _analysisQueue.length + _activeAnalyses;
      qEl.textContent = n > 0 ? `${n} queued` : `${_analysisCache.size} pre-analysed`;
      qEl.style.color = n > 0 ? '#e8c040' : '#4b5563';
    }
    const ovEl = document.getElementById('lm-override-status');
    if (ovEl) {
      ovEl.textContent = _getGlobalEnabled()
        ? `Global override ON → ${_getGlobalTarget().toFixed(1)} LUFS` : 'Global override off';
      ovEl.style.color = _getGlobalEnabled() ? '#e8c040' : '#4b5563';
    }
  }

  function _setPanelStatus(msg, color) {
    const el = document.getElementById('lm-panel-status');
    if (el) { el.textContent = msg; el.style.color = color || '#9ca3af'; el.style.display = msg ? 'block' : 'none'; }
    // Also update settings screen status
    const el2 = document.getElementById('lm-preflight-status');
    if (el2) { el2.textContent = msg; el2.style.color = color || '#9ca3af'; el2.style.display = msg ? 'block' : 'none'; }
  }

  // -------------------------------------------------------------------------
  // Floating side panel — the primary live metering UI
  // -------------------------------------------------------------------------
  let _panelVisible = false;

  function _buildPanel() {
    if (document.getElementById('lm-float-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'lm-float-panel';
    // Matches tuner card style: centred float, rounded, subtle border, dark bg
    panel.style.cssText = `
      position: fixed;
      top: 80px;
      right: 8px;
      width: 300px;
      background: #131920;
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 12px;
      z-index: 9999;
      box-shadow: 0 8px 40px rgba(0,0,0,.7);
      font-family: ui-sans-serif, system-ui, sans-serif;
      color: #d1d5db;
      display: none;
      overflow: hidden;
    `;

    panel.innerHTML = `
      <!-- Title row — centred label + gear icon top-right (matches tuner) -->
      <div style="position:relative;padding:16px 16px 10px;text-align:center;">
        <span style="font-size:11px;font-weight:600;letter-spacing:.12em;
          text-transform:uppercase;color:#6b7280;">LUFS Meter</span>
        <a id="lm-panel-settings-link" href="#" title="Settings"
          style="position:absolute;right:14px;top:14px;color:#4b5563;
            text-decoration:none;font-size:16px;line-height:1;">⚙</a>
        <span id="lm-panel-format" style="position:absolute;left:14px;top:16px;
          font-size:10px;text-transform:uppercase;letter-spacing:.05em;
          color:#4080e0;background:#1e3a5f;padding:1px 6px;border-radius:999px;">–</span>
      </div>

      <!-- Live readings -->
      <div style="padding:4px 20px 14px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:14px;">
          <div style="text-align:center;">
            <div style="font-size:10px;color:#4b5563;margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em;">Momentary</div>
            <div id="lm-panel-momentary" style="font-size:26px;font-weight:700;
              font-family:ui-monospace,monospace;color:#6b7280;">–</div>
            <div style="font-size:10px;color:#4b5563;">LUFS</div>
          </div>
          <div style="width:1px;background:rgba(255,255,255,.06);margin:0 4px;"></div>
          <div style="text-align:center;">
            <div style="font-size:10px;color:#4b5563;margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em;">Short-term (3s)</div>
            <div id="lm-panel-short-term" style="font-size:26px;font-weight:700;
              font-family:ui-monospace,monospace;color:#6b7280;">–</div>
            <div style="font-size:10px;color:#4b5563;">LUFS</div>
          </div>
        </div>

        <!-- Bar -->
        <div style="position:relative;height:6px;background:rgba(255,255,255,.06);
          border-radius:3px;margin-bottom:6px;overflow:visible;">
          <div style="position:absolute;inset:0;overflow:hidden;border-radius:3px;">
            <div id="lm-panel-bar" style="height:100%;width:0%;border-radius:3px;
              background:#22c55e;transition:width .4s,background .4s;"></div>
          </div>
          <div id="lm-panel-target-line" style="display:none;position:absolute;
            top:-3px;bottom:-3px;width:2px;background:#e8c040;border-radius:1px;
            transform:translateX(-50%);pointer-events:none;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:#374151;">
          <span>–40</span><span>–30</span><span>–20</span><span>–16</span><span>–14</span><span>–6</span>
        </div>
      </div>

      <!-- Gain breakdown -->
      <div style="margin:0 14px 14px;background:rgba(255,255,255,.03);border-radius:10px;
        padding:10px 12px;">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;text-align:center;">
          <div>
            <div style="font-size:9px;color:#4b5563;margin-bottom:2px;text-transform:uppercase;letter-spacing:.05em;">PSARC</div>
            <div id="lm-panel-manifest" style="font-size:12px;font-weight:700;
              font-family:ui-monospace,monospace;color:#6b7280;">0.0 dB</div>
          </div>
          <div>
            <div style="font-size:9px;color:#4b5563;margin-bottom:2px;text-transform:uppercase;letter-spacing:.05em;">Trim</div>
            <div id="lm-panel-trim" style="font-size:12px;font-weight:700;
              font-family:ui-monospace,monospace;color:#4080e0;">0.0 dB</div>
          </div>
          <div>
            <div style="font-size:9px;color:#4b5563;margin-bottom:2px;text-transform:uppercase;letter-spacing:.05em;">Total</div>
            <div id="lm-panel-total" style="font-size:12px;font-weight:700;
              font-family:ui-monospace,monospace;color:#f3f4f6;">0.0 dB</div>
          </div>
        </div>
      </div>

      <!-- Status + provisional badge -->
      <div style="padding:0 20px 10px;min-height:20px;">
        <div id="lm-panel-status" style="font-size:11px;font-family:ui-monospace,monospace;
          color:#9ca3af;display:none;margin-bottom:4px;text-align:center;"></div>
        <div style="text-align:center;">
          <span id="lm-panel-provisional" style="display:none;font-size:10px;color:#e8c040;
            background:#2d2500;padding:1px 8px;border-radius:999px;">⏳ provisional</span>
        </div>
      </div>

      <!-- Trim controls -->
      <div style="padding:0 20px 16px;">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;">
          <button id="lm-panel-minus" style="width:32px;height:32px;border-radius:8px;
            border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);
            color:#d1d5db;font-size:18px;cursor:pointer;
            display:flex;align-items:center;justify-content:center;">−</button>
          <input id="lm-panel-trim-input" type="number" step="0.1" min="-20" max="20"
            style="width:64px;text-align:center;background:rgba(255,255,255,.05);
              border:1px solid rgba(255,255,255,.1);color:#f3f4f6;
              font-family:ui-monospace,monospace;font-size:14px;
              border-radius:8px;padding:5px 0;outline:none;" />
          <span style="font-size:11px;color:#6b7280;">dB</span>
          <button id="lm-panel-plus" style="width:32px;height:32px;border-radius:8px;
            border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);
            color:#d1d5db;font-size:18px;cursor:pointer;
            display:flex;align-items:center;justify-content:center;">+</button>
          <button id="lm-panel-reset" style="padding:5px 12px;border-radius:8px;
            border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);
            color:#9ca3af;font-size:11px;cursor:pointer;">Reset</button>
        </div>
      </div>

      <!-- CLOSE — full width, matches tuner exactly -->
      <div style="padding:0 14px 14px;">
        <button id="lm-panel-close"
          style="width:100%;padding:14px;border-radius:12px;
            border:1px solid rgba(255,255,255,.08);
            background:rgba(255,255,255,.05);
            color:#9ca3af;font-size:13px;font-weight:600;
            letter-spacing:.08em;text-transform:uppercase;
            cursor:pointer;">
          CLOSE
        </button>
      </div>

      <!-- Version -->
      <div style="padding:0 14px 10px;text-align:center;">
        <span style="font-size:9px;color:#2d3748;font-family:ui-monospace,monospace;">v${VERSION}</span>
      </div>
    `;

    document.body.appendChild(panel);

    // Wire panel controls
    document.getElementById('lm-panel-close').addEventListener('click', _hidePanel);
    document.getElementById('lm-panel-minus').addEventListener('click', () => _setUserTrim(_userTrimDb - 0.5));
    document.getElementById('lm-panel-plus').addEventListener('click',  () => _setUserTrim(_userTrimDb + 0.5));
    document.getElementById('lm-panel-reset').addEventListener('click', () => _setUserTrim(0, false));
    document.getElementById('lm-panel-trim-input').addEventListener('change', function () {
      const v = parseFloat(this.value);
      if (!isNaN(v)) _setUserTrim(v, false);
    });
    document.getElementById('lm-panel-settings-link').addEventListener('click', (e) => {
      e.preventDefault();
      _hidePanel();
      window.showScreen && window.showScreen('plugin-lufs-meter');
    });
  }

  function _showPanel() {
    _buildPanel();
    const panel = document.getElementById('lm-float-panel');
    if (panel) { panel.style.display = 'block'; _panelVisible = true; _updateAllDisplays(); }
  }

  function _hidePanel() {
    const panel = document.getElementById('lm-float-panel');
    if (panel) { panel.style.display = 'none'; _panelVisible = false; }
  }

  function _togglePanel() {
    if (_panelVisible) _hidePanel(); else _showPanel();
  }

  // -------------------------------------------------------------------------
  // Player navbar widget
  // -------------------------------------------------------------------------
  function _injectPlayerWidget() {
    if (document.getElementById('lm-player-widget')) return;
    const controls = document.getElementById('player-controls');
    if (!controls) return;

    // Compact LUFS readout in the player bar (same region as existing controls)
    const w = document.createElement('div');
    w.id = 'lm-player-widget';
    w.title = 'LUFS Meter — click to show/hide';
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
    w.addEventListener('click', _togglePanel);
    controls.appendChild(w);

    // Persistent "LUFS" pill button — bottom-right corner, same style as the Tuner button
    if (!document.getElementById('lm-pill-btn')) {
      const pill = document.createElement('button');
      pill.id = 'lm-pill-btn';
      pill.textContent = 'LUFS';
      pill.style.cssText = `
        position: fixed;
        bottom: 16px;
        right: 96px;
        padding: 10px 18px;
        background: #1e3a5f;
        border: 1px solid rgba(64,128,224,.4);
        border-radius: 12px;
        color: #4080e0;
        font-size: 14px;
        font-weight: 600;
        font-family: ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
        z-index: 9998;
        user-select: none;
        letter-spacing: .02em;
      `;
      pill.addEventListener('click', _togglePanel);
      document.body.appendChild(pill);
    }
  }

  new MutationObserver(() => {
    if (document.getElementById('player-controls')) _injectPlayerWidget();
  }).observe(document.body, { childList: true, subtree: true });
  _injectPlayerWidget();

  // -------------------------------------------------------------------------
  // Plugin screen (settings) init — called when screen.html is shown via nav
  // -------------------------------------------------------------------------
  window._lufs_meter_init_screen = function () {
    // Settings screen — does NOT touch the audio graph

    document.getElementById('lm-btn-back')?.addEventListener('click', () => {
      if (typeof esc === 'function') esc();
    });
    document.getElementById('lm-btn-minus')?.addEventListener('click', () => _setUserTrim(_userTrimDb - 0.5));
    document.getElementById('lm-btn-plus')?.addEventListener('click',  () => _setUserTrim(_userTrimDb + 0.5));
    document.getElementById('lm-btn-reset')?.addEventListener('click', () => _setUserTrim(0, false));
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
      _setPanelStatus('sampling…', '#9ca3af');
      const lufs = await _sampleAudioUrl(_currentAudioUrl);
      if (lufs !== null && isFinite(lufs)) {
        _setUserTrim(_getGlobalTarget() - lufs - _manifestOffsetDb, false);
        _setPanelStatus(`sampled: ${lufs.toFixed(1)} LUFS → ${_fmtDb(_userTrimDb)}`, '#9ca3af');
      } else {
        _setPanelStatus('sample decode failed', '#ef4444');
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
    _updateAllDisplays();
  };

  function _updateOverrideUI() {
    const toggle   = document.getElementById('lm-override-toggle');
    const targetEl = document.getElementById('lm-override-target');
    const row      = document.getElementById('lm-override-controls');
    if (toggle)   toggle.checked = _getGlobalEnabled();
    if (targetEl) targetEl.value = _getGlobalTarget().toFixed(1);
    if (row)      row.style.opacity = _getGlobalEnabled() ? '1' : '0.4';
    _updateAllDisplays();
  }

  // -------------------------------------------------------------------------
  // Slopsmith event hooks
  // -------------------------------------------------------------------------
  window.slopsmith?.on('song:play', (info) => {
    _onSongPlay(info || {});
  });

  const _origPlaySong = window.playSong;
  if (typeof _origPlaySong === 'function') {
    window.playSong = async function (song, options) {
      const result = await _origPlaySong.call(this, song, options);
      _setupAudioGraph();
      return result;
    };
  }

  _hookLibraryCards();
  _hookSongPreview();

  // Start meter loop
  _lastMeasure = 0;
  _rafId = requestAnimationFrame(_measureTick);

  // Connect audio graph on script load
  _setupAudioGraph();

  // Init the settings screen (screen.html is already in DOM at this point)
  _lufs_meter_init_screen();

})();
