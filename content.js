(function () {
  'use strict';

  // ===== Default settings =====
  const DEFAULTS = {
    targetRate: 9,      // desired syllable rate (syl/s) heard by user
    minSpeed: 1.0,
    maxSpeed: 3.5,
    smoothingSec: 1.5,  // time constant of speed changes (s)
    silenceHoldSec: 3,  // seconds of silence before ramping toward 1×
  };

  // ===== State =====
  let enabled = false;
  let settings = { ...DEFAULTS };
  let currentSpeed = 1.0;

  let activeVideo = null;
  let audioCtx = null;
  let sourceNode = null;
  let analyserNode = null;
  let pollTimer = null;
  let overlayHost = null;
  let overlayEls = {};       // all overlay DOM refs

  // Syllable detector: dB peak picking on a 10 ms energy envelope.
  // The previous approach (zero-crossings of a high-passed 33 Hz envelope)
  // could not resolve syllables once the video was sped up past ~2×, read
  // that as slow speech and sped up further until it hit maxSpeed. Here every
  // frame is stamped in media time (wall time × playbackRate), so the rate is
  // the speaker's natural rate at any playback speed, and it is computed over
  // voiced time only, so pauses don't make a speaker look slow.
  const detector = {
    // Framing
    frameSec: 0.01,          // 10 ms analysis frames
    smoothFrames: 3,         // 30 ms power average, covers >= 2 pitch periods

    // Peak picking: a syllable nucleus is a peak with a dip of at least
    // prominenceDb on both sides
    prominenceDb: 3,
    minPeakIntervalMs: 80,   // media ms — caps at 12.5 syl/s

    // Voicing gate: louder than the noise floor + floorMarginDb and within
    // peakRangeDb of recent speech peaks. Both levels drift back slowly.
    floorMarginDb: 10,
    peakRangeDb: 25,
    driftDbPerSec: 2,
    maxGapMs: 200,           // media ms — shorter dips are between syllables, not pauses
    pauseSec: 0.25,          // wall s without voiced frames before speed is held

    // Rate window
    windowMs: 6000,          // media ms
    minVoicedMs: 1000,       // media ms of speech needed before trusting the rate
  };

  // Scrolling log buffer (last N entries)
  const LOG_MAX = 12;
  let logEntries = [];       // { time, naturalRate, speed, state }
  let lastLogTime = 0;

  // Diagnostics
  let diag = {
    stage: 'idle',
    videoSrc: '',
    streamTracks: 0,
    pollTicks: 0,
    levelDb: -120,
    thresholdDb: -120,
    peakCount: 0,
    voicedSec: 0,
    lastNaturalRate: 0,
    lastTargetSpeed: 0,
    silenceSec: 0,
  };

  function log(msg, ...args) {
    console.log(`%c[SpeechSpeed]%c ${msg}`, 'color:#4ade80;font-weight:bold', 'color:inherit', ...args);
  }

  // ===== Storage =====
  log('Content script loaded on %s', location.href);
  chrome.storage.local.get(['enabled', 'settings'], (data) => {
    if (data.enabled !== undefined) enabled = data.enabled;
    if (data.settings) settings = { ...DEFAULTS, ...data.settings };
    log('Stored state: enabled=%s  settings=%o', enabled, settings);
    if (enabled) init();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (enabled) init(); else teardown();
    }
    if (changes.settings) {
      settings = { ...DEFAULTS, ...changes.settings.newValue };
    }
  });

  // ===== Message handling (popup ↔ content) =====
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getStatus') {
      sendResponse({ enabled, currentSpeed, hasVideo: !!activeVideo, settings });
    } else if (msg.type === 'toggle') {
      enabled = !enabled;
      log('Toggled: enabled=%s', enabled);
      chrome.storage.local.set({ enabled });
      if (enabled) init(); else teardown();
      sendResponse({ enabled });
    } else if (msg.type === 'updateSettings') {
      settings = { ...DEFAULTS, ...msg.settings };
      chrome.storage.local.set({ settings });
      sendResponse({ ok: true });
    }
    return true;
  });

  // ===== Initialization =====
  function init() {
    findAndAttach();
    observeDom();
  }

  let domObserver = null;

  function observeDom() {
    if (domObserver) return;
    domObserver = new MutationObserver(() => {
      if (!activeVideo || !document.contains(activeVideo)) {
        teardownAudio();
        findAndAttach();
      }
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function findAndAttach() {
    const videos = document.querySelectorAll('video');
    log('Scanning for videos: found %d', videos.length);
    if (videos.length === 0) { diag.stage = 'waiting for <video>'; return; }

    let best = null;
    let bestArea = 0;
    videos.forEach((v) => {
      const area = v.clientWidth * v.clientHeight;
      if (area > bestArea) { best = v; bestArea = area; }
    });
    if (!best) best = videos[0];
    if (best === activeVideo && audioCtx) return;

    teardownAudio();
    activeVideo = best;
    diag.videoSrc = (activeVideo.src || activeVideo.currentSrc || '').slice(0, 80);
    log('Attaching to video (%d×%d)', activeVideo.clientWidth, activeVideo.clientHeight);

    if (activeVideo.readyState >= 2) {
      setupAudio(activeVideo);
    } else {
      diag.stage = 'waiting for canplay';
      activeVideo.addEventListener('canplay', function onCanPlay() {
        activeVideo.removeEventListener('canplay', onCanPlay);
        setupAudio(activeVideo);
      });
    }
  }

  // ===== Audio pipeline =====
  async function setupAudio(video) {
    try {
      diag.stage = 'creating AudioContext';
      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      log('AudioContext: %s, %d Hz', audioCtx.state, audioCtx.sampleRate);

      diag.stage = 'capturing stream';
      let stream;
      try { stream = video.captureStream(); }
      catch { stream = video.mozCaptureStream(); }

      const audioTracks = stream.getAudioTracks();
      diag.streamTracks = audioTracks.length;
      log('MediaStream: %d audio tracks', audioTracks.length);
      if (audioTracks.length === 0) {
        log('WARNING: No audio tracks!');
        diag.stage = 'ERROR: no audio tracks';
      }

      sourceNode = audioCtx.createMediaStreamSource(stream);

      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 300;
      highpass.Q.value = 0.7;

      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 3000;
      lowpass.Q.value = 0.7;

      // Only the samples rendered since the previous poll are analysed; the
      // large buffer is headroom so a late timer tick doesn't lose audio.
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 16384;
      analyserNode.smoothingTimeConstant = 0;

      sourceNode.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(analyserNode);

      resetDetector();

      const buf = new Float32Array(analyserNode.fftSize);
      pollTimer = setInterval(() => pollAnalyser(buf), 30);

      diag.stage = 'running';
      log('Pipeline running. target=%s min=%s max=%s', settings.targetRate, settings.minSpeed, settings.maxSpeed);

      createOverlay();
      currentSpeed = video.playbackRate || 1;
      logEntries = [];
    } catch (err) {
      diag.stage = 'ERROR: ' + err.message;
      log('FAILED: %O', err);
    }
  }

  // ===== Syllable detection =====
  function resetDetector() {
    const d = detector;
    const now = performance.now();
    d.frameLen = Math.round(audioCtx.sampleRate * d.frameSec);
    d.frameSum = 0;
    d.frameFill = 0;
    d.pw = new Float64Array(d.smoothFrames);
    d.pwIdx = 0;
    d.pwCount = 0;
    d.mediaMs = 0;           // media time of audio analysed so far
    d.floorDb = Infinity;
    d.peakDb = -Infinity;
    d.rising = true;
    d.candMaxDb = -Infinity;
    d.candT = 0;
    d.candMinDb = Infinity;
    d.lastPeakT = -Infinity;
    d.peaks = [];            // media timestamps of syllable nuclei
    d.voiced = [];           // [media time, media duration] of voiced frames
    d.gap = [];              // unvoiced frames that may still be a dip between syllables
    d.gapMs = 0;
    d.rate = 0;              // natural syllables per voiced second
    d.lastCtxTime = audioCtx.currentTime;
    d.lastPollWall = now;
    d.lastVoicedWall = now;
  }

  function pollAnalyser(buffer) {
    if (!analyserNode) return;
    const d = detector;
    diag.pollTicks++;
    const now = performance.now();
    const ctxTime = audioCtx.currentTime;
    let n = Math.round((ctxTime - d.lastCtxTime) * audioCtx.sampleRate);
    d.lastCtxTime = ctxTime;

    // Paused, seeking or buffering: drop the audio and stop the clocks, so
    // neither the silence timer nor the speed smoothing jumps on resume
    if (activeVideo && (activeVideo.paused || activeVideo.seeking || activeVideo.readyState < 3)) {
      d.lastVoicedWall += now - d.lastPollWall;
      d.lastPollWall = now;
      return;
    }

    // Cut the samples rendered since the previous poll into frames
    analyserNode.getFloatTimeDomainData(buffer);
    n = Math.min(Math.max(n, 0), buffer.length);
    const frameMediaMs = d.frameLen / audioCtx.sampleRate * 1000 * (activeVideo ? activeVideo.playbackRate : 1);
    for (let i = buffer.length - n; i < buffer.length; i++) {
      d.frameSum += buffer[i] * buffer[i];
      if (++d.frameFill === d.frameLen) {
        processFrame(d.frameSum / d.frameLen, frameMediaMs, now);
        d.frameSum = 0;
        d.frameFill = 0;
      }
    }

    // Rate = syllables per voiced second over the last windowMs of media
    const cutoff = d.mediaMs - d.windowMs;
    while (d.peaks.length && d.peaks[0] < cutoff) d.peaks.shift();
    while (d.voiced.length && d.voiced[0][0] < cutoff) d.voiced.shift();
    let voicedMs = 0;
    for (const v of d.voiced) voicedMs += v[1];
    if (voicedMs >= d.minVoicedMs) d.rate = d.peaks.length / (voicedMs / 1000);

    const dt = (now - d.lastPollWall) / 1000;
    d.lastPollWall = now;
    const silenceSec = (now - d.lastVoicedWall) / 1000;

    diag.peakCount = d.peaks.length;
    diag.voicedSec = voicedMs / 1000;
    diag.silenceSec = silenceSec;

    if (!enabled || !activeVideo) return;

    const shouldLog = diag.pollTicks % 66 === 0;

    // Pause: hold the speed, then ease back toward 1× after silenceHoldSec
    if (d.rate === 0 || silenceSec > d.pauseSec) {
      diag.lastNaturalRate = 0;
      diag.lastTargetSpeed = currentSpeed;
      if (silenceSec > settings.silenceHoldSec) {
        currentSpeed += (1 - Math.exp(-dt)) * (1 - currentSpeed);
        applySpeed();
      }
      if (shouldLog) {
        log('SILENCE  level=%.1f dB  threshold=%.1f dB  silence=%.1fs  speed=%.2f',
            diag.levelDb, diag.thresholdDb, silenceSec, currentSpeed);
      }
      addLogEntry(now, 0, currentSpeed, 'silence');
      updateOverlay();
      return;
    }

    // No division by the playback speed: the rate is already in media time
    diag.lastNaturalRate = d.rate;
    const targetSpeed = settings.targetRate / d.rate;
    const clamped = Math.max(settings.minSpeed, Math.min(settings.maxSpeed, targetSpeed));
    diag.lastTargetSpeed = clamped;

    currentSpeed += (1 - Math.exp(-dt / settings.smoothingSec)) * (clamped - currentSpeed);

    if (shouldLog) {
      log('SPEECH  peaks=%d  voiced=%.1fs  natural=%.1f syl/s  target=%.2fx  speed=%.2fx',
          d.peaks.length, voicedMs / 1000, d.rate, clamped, currentSpeed);
    }

    applySpeed();
    addLogEntry(now, d.rate, currentSpeed, 'speech');
    updateOverlay();
  }

  // One 10 ms frame: update the levels, voiced time and peak picker.
  function processFrame(power, dm, now) {
    const d = detector;
    d.pw[d.pwIdx] = power;
    d.pwIdx = (d.pwIdx + 1) % d.pw.length;
    if (d.pwCount < d.pw.length) d.pwCount++;
    let sum = 0;
    for (let i = 0; i < d.pwCount; i++) sum += d.pw[i];
    const db = 10 * Math.log10(sum / d.pwCount + 1e-12);
    d.mediaMs += dm;
    const t = d.mediaMs;

    // Noise floor follows the quietest frames, speech level the loudest;
    // both drift back so they keep adapting
    const drift = d.driftDbPerSec * d.frameSec;
    d.floorDb = db < d.floorDb ? db : d.floorDb + drift;
    d.peakDb = db > d.peakDb ? db : d.peakDb - drift;
    const threshold = Math.max(d.floorDb + d.floorMarginDb, d.peakDb - d.peakRangeDb);
    diag.levelDb = db;
    diag.thresholdDb = threshold;

    // Voiced time; dips shorter than maxGapMs are between syllables and count
    if (db > threshold) {
      if (d.gapMs < d.maxGapMs) d.voiced.push(...d.gap);
      d.gap = [];
      d.gapMs = 0;
      d.voiced.push([t, dm]);
      d.lastVoicedWall = now;
    } else if (d.gapMs < d.maxGapMs) {
      d.gap.push([t, dm]);
      d.gapMs += dm;
    }

    // Peak picker with hysteresis: a peak counts once the level has fallen
    // prominenceDb below it, and the next one can only start after rising
    // prominenceDb above the dip
    if (d.rising) {
      if (db > d.candMaxDb) {
        d.candMaxDb = db;
        d.candT = t;
      } else if (db < d.candMaxDb - d.prominenceDb) {
        if (d.candMaxDb > threshold && d.candT - d.lastPeakT >= d.minPeakIntervalMs) {
          d.peaks.push(d.candT);
          d.lastPeakT = d.candT;
        }
        d.rising = false;
        d.candMinDb = db;
      }
    } else if (db < d.candMinDb) {
      d.candMinDb = db;
    } else if (db > d.candMinDb + d.prominenceDb) {
      d.rising = true;
      d.candMaxDb = db;
      d.candT = t;
    }
  }

  function addLogEntry(now, naturalRate, speed, state) {
    // Only add once per second to keep log readable
    if (now - lastLogTime < 1000) return;
    lastLogTime = now;
    logEntries.push({ naturalRate, speed, state });
    if (logEntries.length > LOG_MAX) logEntries.shift();
  }

  function teardownAudio() {
    log('Tearing down');
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (analyserNode) { try { analyserNode.disconnect(); } catch {} analyserNode = null; }
    if (sourceNode) { try { sourceNode.disconnect(); } catch {} sourceNode = null; }
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
    if (activeVideo && currentSpeed !== 1) {
      try { activeVideo.playbackRate = 1; } catch {}
    }
    currentSpeed = 1;
    diag.stage = 'idle';
    diag.pollTicks = 0;
    removeOverlay();
  }

  function teardown() {
    teardownAudio();
    activeVideo = null;
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
  }

  function applySpeed() {
    if (!activeVideo) return;
    const rounded = Math.round(currentSpeed * 100) / 100;
    if (activeVideo.playbackRate !== rounded) {
      activeVideo.playbackRate = rounded;
    }
  }

  // ===== Overlay =====
  function createOverlay() {
    if (overlayHost) return;

    overlayHost = document.createElement('div');
    overlayHost.id = 'speech-speed-host';
    const shadow = overlayHost.attachShadow({ mode: 'closed' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .ss {
          position: fixed;
          top: 10px;
          right: 10px;
          z-index: 2147483647;
          background: rgba(0, 0, 0, 0.88);
          color: #fff;
          font: 12px/1.4 'SF Mono', 'Menlo', 'Consolas', monospace;
          padding: 10px 14px;
          border-radius: 10px;
          pointer-events: none;
          user-select: none;
          min-width: 260px;
        }

        /* Big hero numbers */
        .ss-hero {
          display: flex;
          justify-content: space-around;
          text-align: center;
          margin-bottom: 6px;
        }
        .ss-hero-item .num {
          font-size: 28px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          line-height: 1.1;
        }
        .ss-hero-item .lbl {
          font-size: 10px;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .speed-color { color: #4ade80; }

        /* State badge */
        .ss-state {
          text-align: center;
          font-size: 11px;
          font-weight: 600;
          padding: 2px 0 6px;
        }
        .speaking { color: #4ade80; }
        .silence  { color: #f59e0b; }

        /* Energy bar */
        .ss-bar-wrap {
          height: 3px;
          background: #333;
          border-radius: 2px;
          margin: 0 0 8px;
          overflow: hidden;
        }
        .ss-bar {
          height: 100%;
          background: #4ade80;
          border-radius: 2px;
          transition: width 0.15s;
          width: 0%;
        }

        /* Scrolling log */
        .ss-log-title {
          font-size: 10px;
          color: #666;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 3px;
        }
        .ss-log {
          font-size: 11px;
          line-height: 1.5;
          max-height: 216px;
          overflow: hidden;
        }
        .ss-log-row {
          display: flex;
          gap: 6px;
          opacity: 0.5;
        }
        .ss-log-row:last-child {
          opacity: 1;
          font-weight: 600;
        }
        .ss-log-row:nth-last-child(2) { opacity: 0.8; }
        .ss-log-row:nth-last-child(3) { opacity: 0.65; }
        .log-rate { color: #60a5fa; min-width: 70px; }
        .log-arrow { color: #555; }
        .log-speed { color: #4ade80; min-width: 50px; }
        .log-state { color: #888; font-size: 10px; }
        .log-silence .log-rate { color: #f59e0b; }
        .log-silence .log-speed { color: #f59e0b; }

        /* Small stats row */
        .ss-stats {
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          color: #555;
          margin-top: 6px;
          padding-top: 4px;
          border-top: 1px solid #222;
        }
      </style>
      <div class="ss">
        <div class="ss-hero">
          <div class="ss-hero-item">
            <div class="num speed-color" id="ss-speed">1.00x</div>
            <div class="lbl">Speed</div>
          </div>
          <div class="ss-hero-item">
            <div class="num" id="ss-rate" style="color:#60a5fa">--</div>
            <div class="lbl">syl/s (natural)</div>
          </div>
        </div>

        <div class="ss-state" id="ss-state">--</div>
        <div class="ss-bar-wrap"><div class="ss-bar" id="ss-bar"></div></div>

        <div class="ss-log-title">History (rate → speed)</div>
        <div class="ss-log" id="ss-log"></div>

        <div class="ss-stats">
          <span id="ss-peaks">peaks: 0</span>
          <span id="ss-ticks">ticks: 0</span>
          <span id="ss-stage">idle</span>
        </div>
      </div>
    `;

    overlayEls = {
      speed: shadow.getElementById('ss-speed'),
      rate:  shadow.getElementById('ss-rate'),
      state: shadow.getElementById('ss-state'),
      bar:   shadow.getElementById('ss-bar'),
      log:   shadow.getElementById('ss-log'),
      peaks: shadow.getElementById('ss-peaks'),
      ticks: shadow.getElementById('ss-ticks'),
      stage: shadow.getElementById('ss-stage'),
    };
    document.documentElement.appendChild(overlayHost);
  }

  function updateOverlay() {
    const e = overlayEls;
    if (!e.speed) return;

    // Hero numbers
    e.speed.textContent = currentSpeed.toFixed(2) + 'x';
    const nr = diag.lastNaturalRate;
    e.rate.textContent = nr > 0 ? nr.toFixed(1) : '--';

    // State
    if (nr > 0) {
      e.state.textContent = 'SPEAKING';
      e.state.className = 'ss-state speaking';
    } else {
      e.state.textContent = 'SILENCE ' + diag.silenceSec.toFixed(0) + 's';
      e.state.className = 'ss-state silence';
    }

    // Energy bar
    const barPct = Math.min(100, Math.max(0, (diag.levelDb + 100) * 1.25));
    e.bar.style.width = barPct + '%';

    // Scrolling log
    let html = '';
    for (const entry of logEntries) {
      const isSilence = entry.state === 'silence';
      const cls = isSilence ? 'ss-log-row log-silence' : 'ss-log-row';
      const rateStr = isSilence ? 'silence' : entry.naturalRate.toFixed(1) + ' syl/s';
      html += `<div class="${cls}">` +
        `<span class="log-rate">${rateStr}</span>` +
        `<span class="log-arrow">→</span>` +
        `<span class="log-speed">${entry.speed.toFixed(2)}x</span>` +
        `</div>`;
    }
    e.log.innerHTML = html;

    // Stats
    e.peaks.textContent = 'peaks: ' + diag.peakCount + ' / ' + diag.voicedSec.toFixed(1) + 's';
    e.ticks.textContent = 'ticks: ' + diag.pollTicks;
    e.stage.textContent = diag.stage;
  }

  function removeOverlay() {
    if (overlayHost && overlayHost.parentNode) {
      overlayHost.parentNode.removeChild(overlayHost);
    }
    overlayHost = null;
    overlayEls = {};
  }
})();
