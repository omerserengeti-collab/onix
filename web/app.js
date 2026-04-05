/* ============================================================
   Onix Web — app.js
   Pure vanilla JS clap-detection app
   ============================================================ */

(function () {
  'use strict';

  // ---- Constants ----
  const COOLDOWN_MS = 3000;
  const CALIBRATION_CLAPS = 3;
  const SETTINGS_KEY = 'onix-settings';
  const ONBOARDING_KEY = 'onix-onboarding-complete';

  // ---- State ----
  let audioContext = null;
  let analyser = null;
  let micStream = null;
  let isListening = false;
  let lastTriggerTime = 0;
  let animFrameId = null;
  let currentThreshold = 4.5;

  // Calibration state
  let calibrating = false;
  let calibrationClaps = [];
  let calibrationCooldown = 0;
  let activeCalibrationContext = null; // 'onboarding' | 'settings'

  // ---- Default settings ----
  function defaultSettings() {
    return {
      music: { service: 'spotify', url: '' },
      windows: [{ url: '' }, { url: '' }],
      threshold: 4.5,
      micDeviceId: 'default',
      clapCount: 0
    };
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return defaultSettings();
  }

  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  function isOnboardingComplete() {
    return localStorage.getItem(ONBOARDING_KEY) === 'true';
  }

  function setOnboardingComplete() {
    localStorage.setItem(ONBOARDING_KEY, 'true');
  }

  // ---- DOM helpers ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ---- Placeholder map ----
  const placeholders = {
    spotify: 'https://open.spotify.com/track/...',
    apple: 'https://music.apple.com/...',
    youtube: 'https://youtube.com/watch?v=...',
    custom: 'https://...'
  };

  // ============================================================
  // SCREENS
  // ============================================================

  function showScreen(id) {
    $$('.screen').forEach(s => s.style.display = 'none');
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
  }

  // ============================================================
  // ONBOARDING
  // ============================================================

  let currentStep = 0;

  function goToStep(n) {
    const prev = currentStep;
    currentStep = n;

    // Update dots
    $$('.progress-dots .dot').forEach((d, i) => {
      d.classList.toggle('active', i <= n);
    });

    // Hide previous step
    const prevStep = $(`#step-${prev}`);
    if (prevStep) {
      prevStep.classList.remove('visible');
      setTimeout(() => {
        prevStep.classList.remove('active');
        // Show next
        showStepEl(n);
      }, 200);
    } else {
      showStepEl(n);
    }
  }

  function showStepEl(n) {
    const el = $(`#step-${n}`);
    if (!el) return;
    el.classList.add('active');
    // Trigger reflow for transition
    void el.offsetWidth;
    el.classList.add('visible');

    // Start calibration mic if step 2
    if (n === 2) {
      startCalibrationMic('onboarding');
    }
  }

  function initOnboarding() {
    const settings = loadSettings();

    // Step 0: Music
    const serviceSelect = $('#music-service');
    const urlInput = $('#music-url');

    serviceSelect.value = settings.music.service || 'spotify';
    urlInput.value = settings.music.url || '';
    urlInput.placeholder = placeholders[serviceSelect.value];

    serviceSelect.addEventListener('change', () => {
      urlInput.placeholder = placeholders[serviceSelect.value];
    });

    $('#step0-next').addEventListener('click', () => {
      // Save music
      const s = loadSettings();
      s.music.service = serviceSelect.value;
      s.music.url = urlInput.value.trim();
      saveSettings(s);
      goToStep(1);
    });

    // Step 1: Windows
    renderWindowEntries('window-entries', settings.windows, 'add-window-btn');

    $('#step1-back').addEventListener('click', () => goToStep(0));
    $('#step1-next').addEventListener('click', () => {
      saveWindowEntries('window-entries');
      goToStep(2);
    });

    // Step 2: Calibration
    $('#step2-back').addEventListener('click', () => {
      stopCalibration();
      goToStep(1);
    });

    $('#step2-finish').addEventListener('click', () => {
      stopCalibration();
      setOnboardingComplete();
      showScreen('dashboard');
      initDashboard();
    });

    // Show step 0
    showStepEl(0);
  }

  // ---- Window entry rendering (shared between onboarding + settings) ----

  function renderWindowEntries(containerId, windows, addBtnId) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    windows.forEach((w, i) => {
      container.appendChild(createWindowRow(w.url, i, containerId, addBtnId));
    });

    const addBtn = document.getElementById(addBtnId);
    addBtn.disabled = windows.length >= 6;
    addBtn.onclick = () => {
      const rows = container.querySelectorAll('.window-entry');
      if (rows.length >= 6) return;
      container.appendChild(createWindowRow('', rows.length, containerId, addBtnId));
      addBtn.disabled = container.querySelectorAll('.window-entry').length >= 6;
    };
  }

  function createWindowRow(url, index, containerId, addBtnId) {
    const div = document.createElement('div');
    div.className = 'window-entry';
    div.innerHTML = `
      <input type="text" class="input-text window-url" placeholder="https://..." value="${escapeAttr(url)}">
      <button class="btn-remove" title="Remove">&times;</button>
    `;
    div.querySelector('.btn-remove').addEventListener('click', () => {
      div.remove();
      const container = document.getElementById(containerId);
      const addBtn = document.getElementById(addBtnId);
      addBtn.disabled = container.querySelectorAll('.window-entry').length >= 6;
    });
    return div;
  }

  function getWindowUrls(containerId) {
    const urls = [];
    document.getElementById(containerId).querySelectorAll('.window-url').forEach(inp => {
      urls.push({ url: inp.value.trim() });
    });
    return urls;
  }

  function saveWindowEntries(containerId) {
    const s = loadSettings();
    s.windows = getWindowUrls(containerId);
    saveSettings(s);
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ============================================================
  // MICROPHONE & AUDIO
  // ============================================================

  async function enumerateMics() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audioinput');
    } catch (e) {
      return [];
    }
  }

  async function populateMicDropdowns() {
    const mics = await enumerateMics();
    const selects = [
      document.getElementById('mic-select'),
      document.getElementById('settings-mic-select')
    ].filter(Boolean);

    selects.forEach(sel => {
      sel.innerHTML = '';
      if (mics.length === 0) {
        const opt = document.createElement('option');
        opt.value = 'default';
        opt.textContent = 'Default microphone';
        sel.appendChild(opt);
        return;
      }
      mics.forEach((m, i) => {
        const opt = document.createElement('option');
        opt.value = m.deviceId;
        opt.textContent = m.label || `Microphone ${i + 1}`;
        sel.appendChild(opt);
      });
    });

    // Set saved device
    const settings = loadSettings();
    selects.forEach(sel => {
      if (settings.micDeviceId) {
        sel.value = settings.micDeviceId;
      }
    });
  }

  async function getMicStream(deviceId) {
    const constraints = {
      audio: deviceId && deviceId !== 'default'
        ? { deviceId: { exact: deviceId } }
        : true
    };
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  async function initAudio(deviceId) {
    // Stop existing
    stopAudio();

    try {
      micStream = await getMicStream(deviceId);
    } catch (err) {
      showScreen('mic-denied');
      return false;
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    const source = audioContext.createMediaStreamSource(micStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);

    // After getting permission, re-enumerate to get labels
    await populateMicDropdowns();

    return true;
  }

  function stopAudio() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
      analyser = null;
    }
  }

  // ============================================================
  // WAVEFORM DRAWING
  // ============================================================

  function drawWaveform(canvas, analyserNode, color) {
    if (!analyserNode || !canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const bufferLength = analyserNode.fftSize;
    const dataArray = new Float32Array(bufferLength);
    analyserNode.getFloatTimeDomainData(dataArray);

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Center line (dotted)
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#D1D5DB';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform
    ctx.strokeStyle = color || '#4F46E5';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    const sliceWidth = w / bufferLength;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i];
      const y = (v * 0.5 + 0.5) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();
  }

  // ============================================================
  // CLAP DETECTION
  // ============================================================

  function getRMS() {
    if (!analyser) return 0;
    const dataArray = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    return Math.sqrt(sum / dataArray.length) * 100;
  }

  // ============================================================
  // CALIBRATION
  // ============================================================

  async function startCalibrationMic(context) {
    activeCalibrationContext = context;
    calibrating = true;
    calibrationClaps = [];
    calibrationCooldown = 0;

    const micSelect = context === 'onboarding' ? $('#mic-select') : $('#settings-mic-select');
    const statusEl = context === 'onboarding' ? $('#mic-status') : $('#settings-mic-status');
    const promptEl = context === 'onboarding' ? $('#calibration-prompt') : $('#settings-calibration-prompt');
    const dots = context === 'onboarding' ? $$('#clap-indicator .clap-dot') : $$('#settings-clap-indicator .clap-dot');
    const successEl = context === 'onboarding' ? $('#calibration-success') : null;
    const finishBtn = context === 'onboarding' ? $('#step2-finish') : null;

    // Reset UI
    dots.forEach(d => d.classList.remove('filled'));
    promptEl.textContent = 'Clap now';
    if (successEl) successEl.classList.add('hidden');
    if (finishBtn) finishBtn.disabled = true;

    const deviceId = micSelect.value;
    const ok = await initAudio(deviceId);
    if (!ok) return;

    statusEl.className = 'mic-status connected';
    statusEl.textContent = 'Microphone connected';

    // Save mic choice
    const s = loadSettings();
    s.micDeviceId = deviceId;
    saveSettings(s);

    // Listen for device change
    micSelect.onchange = async () => {
      const s2 = loadSettings();
      s2.micDeviceId = micSelect.value;
      saveSettings(s2);
      await initAudio(micSelect.value);
      statusEl.className = 'mic-status connected';
      statusEl.textContent = 'Microphone connected';
    };

    // Start animation + detection loop
    runCalibrationLoop(context);
  }

  function runCalibrationLoop(context) {
    const canvasId = context === 'onboarding' ? 'waveform-canvas-onboarding' : 'waveform-canvas-settings';
    const canvas = document.getElementById(canvasId);
    const promptEl = context === 'onboarding' ? $('#calibration-prompt') : $('#settings-calibration-prompt');
    const dots = context === 'onboarding' ? $$('#clap-indicator .clap-dot') : $$('#settings-clap-indicator .clap-dot');
    const successEl = context === 'onboarding' ? $('#calibration-success') : null;
    const finishBtn = context === 'onboarding' ? $('#step2-finish') : null;

    // Use a generous temp threshold for calibration detection
    const CALIB_THRESHOLD = 2.0;

    function loop() {
      if (!calibrating || !analyser) return;

      drawWaveform(canvas, analyser, '#4F46E5');

      const volume = getRMS();
      const now = Date.now();

      if (calibrationClaps.length < CALIBRATION_CLAPS && volume > CALIB_THRESHOLD && now - calibrationCooldown > 800) {
        calibrationClaps.push(volume);
        calibrationCooldown = now;

        const count = calibrationClaps.length;
        dots[count - 1].classList.add('filled');

        if (count < CALIBRATION_CLAPS) {
          promptEl.textContent = `Got it! (${count}/${CALIBRATION_CLAPS}) — clap again`;
        } else {
          // Done
          const minClap = Math.min(...calibrationClaps);
          const threshold = minClap * 0.5;

          const s = loadSettings();
          s.threshold = Math.round(threshold * 100) / 100;
          currentThreshold = s.threshold;
          saveSettings(s);

          promptEl.textContent = '';

          if (successEl) {
            successEl.classList.remove('hidden');
            const pct = Math.min((threshold / 15) * 100, 100);
            $('#threshold-bar').style.width = pct + '%';
            $('#threshold-marker').style.left = pct + '%';
          }

          if (finishBtn) finishBtn.disabled = false;

          // For settings recalibration
          if (context === 'settings') {
            const settingsPrompt = $('#settings-calibration-prompt');
            settingsPrompt.textContent = 'Calibration complete!';
            settingsPrompt.style.color = '#059669';
          }

          calibrating = false;
        }
      }

      animFrameId = requestAnimationFrame(loop);
    }

    animFrameId = requestAnimationFrame(loop);
  }

  function stopCalibration() {
    calibrating = false;
  }

  // ============================================================
  // DASHBOARD
  // ============================================================

  function initDashboard() {
    const settings = loadSettings();
    currentThreshold = settings.threshold || 4.5;

    const toggle = $('#dash-toggle');
    const statusDot = $('#dash-status-dot');
    const statusText = $('#dash-status-text');
    const clapCountEl = $('#dash-clap-count');
    const canvas = $('#waveform-canvas-dash');

    clapCountEl.textContent = settings.clapCount || 0;

    toggle.addEventListener('change', async () => {
      if (toggle.checked) {
        await startListening();
      } else {
        pauseListening();
      }
    });

    function updateStatusUI() {
      if (isListening) {
        statusDot.classList.add('active');
        statusText.textContent = 'Listening...';
      } else {
        statusDot.classList.remove('active');
        statusText.textContent = 'Paused';
      }
    }

    async function startListening() {
      const s = loadSettings();
      const ok = await initAudio(s.micDeviceId);
      if (!ok) return;
      isListening = true;
      updateStatusUI();
      runDashboardLoop();
    }

    function pauseListening() {
      isListening = false;
      stopAudio();
      updateStatusUI();
      // Clear canvas
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function runDashboardLoop() {
      function loop() {
        if (!isListening || !analyser) return;

        drawWaveform(canvas, analyser, '#4F46E5');

        const volume = getRMS();
        const now = Date.now();

        if (volume > currentThreshold && now - lastTriggerTime > COOLDOWN_MS) {
          lastTriggerTime = now;
          onClapDetected();
        }

        animFrameId = requestAnimationFrame(loop);
      }
      animFrameId = requestAnimationFrame(loop);
    }

    function onClapDetected() {
      const s = loadSettings();
      s.clapCount = (s.clapCount || 0) + 1;
      saveSettings(s);
      clapCountEl.textContent = s.clapCount;

      // Stop listening immediately after clap
      pauseListening();

      // Flash
      const flash = $('#clap-flash');
      flash.classList.remove('hidden');

      // Launch: music first, then URLs after delay
      triggerLaunch(s);
    }

    // Start automatically
    startListening();

    // Settings button
    $('#open-settings-btn').addEventListener('click', openSettings);
  }

  // ============================================================
  // LAUNCH LOGIC
  // ============================================================

  function triggerLaunch(settings) {
    const popupWarning = document.getElementById('popup-warning');

    // Step 1: Open music immediately
    if (settings.music && settings.music.url) {
      const w = window.open(settings.music.url, '_blank');
      if (!w) showPopupWarning(popupWarning);
    }

    // Step 2: Open URLs in NEW browser windows (not tabs) with delays
    if (settings.windows) {
      settings.windows.forEach((win, i) => {
        if (win.url) {
          setTimeout(() => {
            const w = window.open(win.url, '_blank', 'width=1280,height=900,noopener');
            if (!w) showPopupWarning(popupWarning);
          }, 3000 + i * 2000);
        }
      });
    }
  }

  function showPopupWarning(el) {
    if (el) el.classList.remove('hidden');
  }

  // ============================================================
  // SETTINGS MODAL
  // ============================================================

  function openSettings() {
    const overlay = $('#settings-overlay');
    overlay.classList.remove('hidden');

    const settings = loadSettings();

    // Music tab
    $('#settings-music-service').value = settings.music.service || 'spotify';
    $('#settings-music-url').value = settings.music.url || '';
    $('#settings-music-url').placeholder = placeholders[$('#settings-music-service').value];

    $('#settings-music-service').onchange = () => {
      $('#settings-music-url').placeholder = placeholders[$('#settings-music-service').value];
    };

    // Apps tab
    renderWindowEntries('settings-window-entries', settings.windows || [{ url: '' }], 'settings-add-window-btn');

    // Calibration tab
    const settingsPrompt = $('#settings-calibration-prompt');
    settingsPrompt.textContent = 'Press "Re-calibrate" to begin';
    settingsPrompt.style.color = '#111';
    $$('#settings-clap-indicator .clap-dot').forEach(d => d.classList.remove('filled'));

    $('#recalibrate-btn').onclick = () => {
      startCalibrationMic('settings');
    };

    // General tab
    const slider = $('#sensitivity-slider');
    const baseThreshold = settings.threshold || 4.5;
    // slider 0 = 0.5x threshold (more sensitive), 100 = 1.5x threshold (less sensitive)
    // default at 50 = 1x
    slider.value = 50;
    updateSensitivityDisplay(baseThreshold, 50);

    slider.oninput = () => {
      updateSensitivityDisplay(baseThreshold, parseInt(slider.value));
    };

    // Reset
    $('#reset-btn').onclick = () => {
      if (confirm('This will erase all your settings and restart onboarding. Continue?')) {
        localStorage.removeItem(SETTINGS_KEY);
        localStorage.removeItem(ONBOARDING_KEY);
        location.reload();
      }
    };

    // Tabs
    $$('.modal-tab').forEach(tab => {
      tab.onclick = () => {
        $$('.modal-tab').forEach(t => t.classList.remove('active'));
        $$('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
      };
    });

    // Activate first tab
    $$('.modal-tab')[0].click();

    // Close
    $('#close-settings').onclick = closeSettings;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSettings();
    });

    // Save
    $('#save-settings-btn').onclick = () => {
      const s = loadSettings();

      // Music
      s.music.service = $('#settings-music-service').value;
      s.music.url = $('#settings-music-url').value.trim();

      // Apps
      s.windows = getWindowUrls('settings-window-entries');

      // Sensitivity
      const sliderVal = parseInt(slider.value);
      const factor = 0.5 + sliderVal / 100; // 0.5x to 1.5x
      s.threshold = Math.round(baseThreshold * factor * 100) / 100;
      currentThreshold = s.threshold;

      saveSettings(s);
      closeSettings();
    };
  }

  function updateSensitivityDisplay(baseThreshold, sliderVal) {
    const factor = 0.5 + sliderVal / 100;
    const adjusted = Math.round(baseThreshold * factor * 100) / 100;
    $('#sensitivity-value').textContent = `Threshold: ${adjusted}`;
  }

  function closeSettings() {
    stopCalibration();
    $('#settings-overlay').classList.add('hidden');
    // Re-read updated threshold
    const s = loadSettings();
    currentThreshold = s.threshold || 4.5;
  }

  // ============================================================
  // INIT
  // ============================================================

  async function init() {
    if (isOnboardingComplete()) {
      showScreen('dashboard');
      initDashboard();
    } else {
      showScreen('onboarding');
      initOnboarding();

      // Request mic permission early to enumerate devices with labels
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach(t => t.stop());
        await populateMicDropdowns();
      } catch (e) {
        showScreen('mic-denied');
        return;
      }
    }
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
