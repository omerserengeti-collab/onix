document.addEventListener('DOMContentLoaded', async () => {
  const card = document.getElementById('card');
  const paywallCard = document.getElementById('paywallCard');
  const toggle = document.getElementById('toggleListening');
  const micSection = document.getElementById('micSection');
  const micSelect = document.getElementById('micSelect');
  const settingsBtn = document.getElementById('settingsBtn');
  const waveformCanvas = document.getElementById('waveformCanvas');

  let threshold = 0.5;
  let currentAudioLevel = 0;
  let waveformAnimId = null;

  // ── Load initial settings ──
  try {
    const settings = await window.onix.getSettings();
    if (settings) {
      threshold = settings.threshold || 0.5;

      // Show paywall if trial exhausted and not licensed
      if (!settings.licenseValid && settings.trialClapsUsed >= (settings.trialMax || 1)) {
        showPaywall();
      }
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }

  // ── Enumerate microphones ──
  async function loadMics() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');
      micSelect.innerHTML = '';
      mics.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || 'Microphone ' + (i + 1);
        micSelect.appendChild(opt);
      });
      // Select saved device
      const settings = await window.onix.getSettings();
      if (settings.micDeviceId) {
        micSelect.value = settings.micDeviceId;
      }
    } catch (e) {
      micSelect.innerHTML = '<option>No microphone</option>';
    }
  }

  micSelect.addEventListener('change', () => {
    const deviceId = micSelect.value;
    window.onix.saveSettings('micDeviceId', deviceId);
    window.onix.selectAudioDevice(deviceId);
  });

  // ── Toggle listening ──
  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    window.onix.toggleListening(enabled);
    updateUI(enabled);
  });

  function updateUI(enabled) {
    if (enabled) {
      micSection.style.display = 'block';
      loadMics();
      startWaveform();
    } else {
      micSection.style.display = 'none';
      stopWaveform();
    }
  }

  // ── Waveform visualizer ──
  const volumeHistory = [];
  const MAX_BARS = 40;

  function startWaveform() {
    if (waveformAnimId) return;
    const ctx = waveformCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = waveformCanvas.clientWidth;
    const h = waveformCanvas.clientHeight;
    waveformCanvas.width = w * dpr;
    waveformCanvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    function draw() {
      volumeHistory.push(currentAudioLevel);
      if (volumeHistory.length > MAX_BARS) volumeHistory.shift();

      ctx.clearRect(0, 0, w, h);
      const barW = (w / MAX_BARS) * 0.7;
      const gap = (w / MAX_BARS) * 0.3;
      const centerY = h / 2;

      for (let i = 0; i < volumeHistory.length; i++) {
        const v = volumeHistory[i];
        const barH = Math.max(2, Math.min(v / 1.5, 1) * (h * 0.85));
        const x = i * (barW + gap) + gap / 2;

        ctx.fillStyle = v > threshold ? '#9FD25D' : '#3a3a3a';
        ctx.beginPath();
        const r = Math.min(barW / 2, 2);
        const top = centerY - barH / 2;
        ctx.moveTo(x + r, top);
        ctx.lineTo(x + barW - r, top);
        ctx.quadraticCurveTo(x + barW, top, x + barW, top + r);
        ctx.lineTo(x + barW, centerY + barH / 2 - r);
        ctx.quadraticCurveTo(x + barW, centerY + barH / 2, x + barW - r, centerY + barH / 2);
        ctx.lineTo(x + r, centerY + barH / 2);
        ctx.quadraticCurveTo(x, centerY + barH / 2, x, centerY + barH / 2 - r);
        ctx.lineTo(x, top + r);
        ctx.quadraticCurveTo(x, top, x + r, top);
        ctx.fill();
      }

      waveformAnimId = requestAnimationFrame(draw);
    }
    draw();
  }

  function stopWaveform() {
    if (waveformAnimId) {
      cancelAnimationFrame(waveformAnimId);
      waveformAnimId = null;
    }
    volumeHistory.length = 0;
  }

  // ── Settings ──
  settingsBtn.addEventListener('click', () => {
    window.onix.openSettings();
  });

  // ── Audio level from main ──
  window.onix.onAudioLevel((volume) => {
    currentAudioLevel = volume;
  });

  // ── Clap detected ──
  window.onix.onClapDetected(() => {
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 300);
  });

  // ── Listening state from main ──
  window.onix.onListeningState((enabled) => {
    toggle.checked = enabled;
    updateUI(enabled);
  });

  // ── Paywall ──
  function showPaywall() {
    card.style.display = 'none';
    paywallCard.style.display = 'block';
    window.onix.resizePopup(380, 520);
  }

  function hidePaywall() {
    paywallCard.style.display = 'none';
    card.style.display = 'flex';
    window.onix.resizePopup(344, 280);
  }

  const buyBtn = document.getElementById('paywallBuyBtn');
  if (buyBtn) {
    buyBtn.addEventListener('click', () => window.onix.buyLicense());
  }

  const activateBtn = document.getElementById('paywallActivateBtn');
  const keyInput = document.getElementById('paywallKeyInput');
  const statusEl = document.getElementById('paywallStatus');

  if (activateBtn) {
    activateBtn.addEventListener('click', async () => {
      const key = keyInput.value.trim();
      if (!key) {
        statusEl.textContent = 'Please enter a license key.';
        statusEl.className = 'pw-status error';
        return;
      }
      statusEl.textContent = 'Validating...';
      statusEl.className = 'pw-status';
      const result = await window.onix.validateLicense(key);
      if (result.valid) {
        statusEl.textContent = 'License activated!';
        statusEl.className = 'pw-status success';
        setTimeout(() => hidePaywall(), 1000);
      } else {
        statusEl.textContent = result.message;
        statusEl.className = 'pw-status error';
      }
    });
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') activateBtn.click();
    });
  }

  window.onix.onShowPaywall(() => showPaywall());

  // ── Countdown ──
  window.onix.onCountdownStart((seconds) => {
    const overlay = document.getElementById('countdownOverlay');
    const numberEl = document.getElementById('countdownNumber');
    overlay.style.display = 'block';
    card.style.display = 'none';

    let remaining = seconds;
    numberEl.textContent = remaining;

    const interval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(interval);
        overlay.style.display = 'none';
        card.style.display = 'flex';
        toggle.checked = true;
        updateUI(true);
      } else {
        numberEl.textContent = remaining;
      }
    }, 1000);
  });

  // ── Auto-Update Banner ──
  const updateBanner = document.getElementById('updateBanner');
  const updateText = document.getElementById('updateText');
  const updateBtn = document.getElementById('updateBtn');

  window.onix.onUpdateAvailable((version) => {
    updateText.textContent = `Downloading v${version}...`;
    updateBanner.style.display = 'flex';
    updateBtn.style.display = 'none';
  });

  window.onix.onUpdateReady((version) => {
    updateText.textContent = `v${version} ready`;
    updateBtn.style.display = 'block';
    updateBanner.style.display = 'flex';
  });

  updateBtn.addEventListener('click', () => {
    window.onix.installUpdate();
  });

  // ── Auto-sync listening state on popup load ──
  try {
    const listening = await window.onix.getListeningState();
    if (listening) {
      toggle.checked = true;
      updateUI(true);
    }
  } catch (e) {}
});
