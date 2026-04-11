document.addEventListener('DOMContentLoaded', () => {
  // ── State ──────────────────────────────────────────────────────────────
  let currentStep = 1;
  let displays = [];
  let claps = [];
  let clapSpectra = [];
  let clapFeatures = [];  // { flatness, subBandRatio, crest } per clap
  let calibrationActive = false;
  let animationFrameId = null;

  const state = {
    music: { service: 'spotify', url: '' },
    windows: [],
    threshold: 0.5,
  };

  // ── Element refs ───────────────────────────────────────────────────────
  const dots = document.querySelectorAll('.dot');
  const steps = document.querySelectorAll('.step');
  const micDevice = document.getElementById('mic-device');
  const micStatusText = document.getElementById('mic-status-text');
  const hwStatus = document.getElementById('hw-status');
  const musicService = document.getElementById('music-service');
  const musicUrl = document.getElementById('music-url');
  const windowEntries = document.getElementById('window-entries');
  const btnAddWindow = document.getElementById('btn-add-window');
  const canvas = document.getElementById('waveform-canvas');
  const calibrationPrompt = document.getElementById('calibration-prompt');
  const clapDots = document.querySelectorAll('.clap-dot');
  const calibrationSuccess = document.getElementById('calibration-success');
  const thresholdBar = document.getElementById('threshold-bar');
  const thresholdMarker = document.getElementById('threshold-marker');
  const btnFinish = document.getElementById('btn-finish');
  const btnRecalibrate = document.getElementById('btn-recalibrate');
  const successText = document.getElementById('success-text');
  const clapValues = [
    document.getElementById('clap-value-1'),
    document.getElementById('clap-value-2'),
    document.getElementById('clap-value-3'),
  ];

  // ── Spectral comparison (cosine similarity, 500Hz–8kHz) ────────────────
  function compareSpectra(a, b, minBin = 23, maxBin = 372) {
    let dot = 0, normA = 0, normB = 0;
    const limit = Math.min(maxBin, a.length, b.length);
    for (let i = minBin; i < limit; i++) {
      const va = Math.pow(10, a[i] / 20);
      const vb = Math.pow(10, b[i] / 20);
      dot += va * vb;
      normA += va * va;
      normB += vb * vb;
    }
    const divisor = Math.sqrt(normA) * Math.sqrt(normB);
    return divisor === 0 ? 0 : dot / divisor;
  }

  // ── Default music URLs (pre-filled, user can clear and type their own) ─
  const defaultUrls = {
    'spotify': 'spotify:track:39shmbIHICJ2Wxnk1fPSdz',
    'youtube': 'https://www.youtube.com/watch?v=xMaE6toi4mk',
  };

  // ── Placeholders per service ───────────────────────────────────────────
  const placeholders = {
    'spotify': 'https://open.spotify.com/track/...',
    'apple': 'https://music.apple.com/...',
    'youtube': 'https://youtube.com/watch?v=...',
    'custom': 'https://...',
  };

  // ── Navigation ─────────────────────────────────────────────────────────
  function goToStep(n) {
    if (n < 1 || n > 4) return;
    const prev = currentStep;

    // Leaving step 4 — stop calibration
    if (prev === 4 && n !== 4) {
      stopCalibration();
    }

    // Animate out
    const currentEl = document.getElementById('step-' + prev);
    currentEl.classList.remove('active');

    // Small delay to allow CSS transition
    setTimeout(() => {
      currentEl.style.display = 'none';
      currentStep = n;

      // Update dots
      dots.forEach((dot) => {
        dot.classList.toggle('active', Number(dot.dataset.step) <= n);
      });

      // Animate in
      const nextEl = document.getElementById('step-' + n);
      nextEl.style.display = 'block';
      // Force reflow so the transition fires
      void nextEl.offsetWidth;
      nextEl.classList.add('active');

      // Entering step 4 — start calibration
      if (n === 4) {
        startCalibration();
      }
    }, 150);
  }

  // Wire navigation buttons
  document.getElementById('btn-next-1').addEventListener('click', () => {
    goToStep(2);
  });

  document.getElementById('btn-back-2').addEventListener('click', () => goToStep(1));
  document.getElementById('btn-next-2').addEventListener('click', () => {
    state.music.service = musicService.value;
    state.music.url = musicUrl.value.trim();
    goToStep(3);
  });

  document.getElementById('btn-back-3').addEventListener('click', () => goToStep(2));
  document.getElementById('btn-next-3').addEventListener('click', () => {
    collectWindowEntries();
    goToStep(4);
    populateCalibrationMic();
  });

  document.getElementById('btn-back-4').addEventListener('click', () => goToStep(3));

  // ── Calibration mic selector ──
  const calibrationMicSelect = document.getElementById('calibration-mic-select');

  async function populateCalibrationMic() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      calibrationMicSelect.innerHTML = '';
      audioInputs.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || 'Microphone ' + (i + 1);
        if (d.deviceId === micDevice.value) opt.selected = true;
        calibrationMicSelect.appendChild(opt);
      });
    } catch (e) {
      calibrationMicSelect.innerHTML = '<option>No mic</option>';
    }
  }

  calibrationMicSelect.addEventListener('change', async () => {
    const deviceId = calibrationMicSelect.value;
    // Update step 1 selector too
    micDevice.value = deviceId;
    await window.onix.saveSettings('micDeviceId', deviceId);
    window.onix.selectAudioDevice(deviceId);
  });

  btnFinish.addEventListener('click', () => {
    collectWindowEntries();
    state.music.service = musicService.value;
    state.music.url = musicUrl.value.trim();

    const settings = {
      music: { ...state.music },
      windows: [...state.windows],
      threshold: state.threshold,
      spectralTemplate: state.spectralTemplate || null,
      spectralThreshold: state.spectralThreshold || null,
      minFlatness: state.minFlatness || null,
      minSubBandRatio: state.minSubBandRatio || null,
      maxSubBandRatio: state.maxSubBandRatio || null,
      minCrest: state.minCrest || null,
      micDeviceId: micDevice.value || null,
    };

    window.onix.finishOnboarding(settings);
  });

  btnRecalibrate.addEventListener('click', () => {
    stopCalibration();
    startCalibration();
  });

  // ── Step 1: Hardware Check — Mic Enumeration ───────────────────────────
  async function initMicDevices() {
    micStatusText.textContent = 'Checking microphone...';
    micStatusText.className = 'mic-status-text checking';
    hwStatus.textContent = '\u23F3';

    try {
      // Request permission first (triggers the OS prompt)
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());

      // Now enumerate all devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');

      micDevice.innerHTML = '';
      audioInputs.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || 'Microphone ' + (i + 1);
        micDevice.appendChild(opt);
      });

      if (audioInputs.length > 0) {
        micStatusText.innerHTML = '\u2705 Microphone OK &mdash; you\'re good to go!';
        micStatusText.className = 'mic-status-text ok';
        hwStatus.textContent = '\u2705';

        // Save initial device selection and tell audio worker
        const deviceId = micDevice.value;
        await window.onix.saveSettings('micDeviceId', deviceId);
        window.onix.selectAudioDevice(deviceId);
      } else {
        micStatusText.innerHTML = '\u274C No microphone detected';
        micStatusText.className = 'mic-status-text error';
        hwStatus.textContent = '\u274C';
      }
    } catch (err) {
      console.error('Mic enumeration failed:', err);
      micStatusText.innerHTML = '\u274C No microphone detected';
      micStatusText.className = 'mic-status-text error';
      hwStatus.textContent = '\u274C';
      micDevice.innerHTML = '<option value="">No access</option>';
    }
  }

  // When user changes mic selection
  micDevice.addEventListener('change', async () => {
    const deviceId = micDevice.value;
    await window.onix.saveSettings('micDeviceId', deviceId);
    window.onix.selectAudioDevice(deviceId);

    const label = micDevice.options[micDevice.selectedIndex].textContent;
    micStatusText.innerHTML = '\u2705 Using: ' + label;
    micStatusText.className = 'mic-status-text ok';
    hwStatus.textContent = '\u2705';
  });

  // ── Step 2: Music Service — Card Selection ─────────────────────────────
  const serviceCards = document.querySelectorAll('.service-card');
  const songPreview = document.getElementById('song-preview');
  const songArt = document.getElementById('song-art');
  const songTitle = document.getElementById('song-title');
  const songArtist = document.getElementById('song-artist');
  let previewTimeout = null;

  const servicePlaceholders = {
    'spotify': 'Paste a Spotify track link...',
    'apple': 'Paste an Apple Music link...',
    'youtube': 'Paste a YouTube video link...',
    'custom': 'Paste any URL...',
  };

  serviceCards.forEach(card => {
    card.addEventListener('click', () => {
      serviceCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const service = card.dataset.service;
      musicService.value = service;
      musicUrl.placeholder = servicePlaceholders[service] || 'Paste a URL...';
      songPreview.style.display = 'none';
      musicUrl.value = defaultUrls[service] || '';
      musicUrl.focus();
    });
  });

  // oEmbed preview on URL paste
  musicUrl.addEventListener('input', () => {
    if (previewTimeout) clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => fetchSongPreview(musicUrl.value.trim()), 600);
  });

  async function fetchSongPreview(url) {
    if (!url) { songPreview.style.display = 'none'; return; }

    const service = musicService.value;

    if (service === 'spotify' && url.includes('spotify.com')) {
      try {
        const resp = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
        if (resp.ok) {
          const data = await resp.json();
          songArt.src = data.thumbnail_url || '';
          songTitle.textContent = data.title || 'Unknown Track';
          songArtist.textContent = data.provider_name || 'Spotify';
          songPreview.style.display = 'flex';
          return;
        }
      } catch (e) { console.log('[Onboarding] oEmbed failed:', e); }
    }

    if (service === 'youtube' && (url.includes('youtube.com') || url.includes('youtu.be'))) {
      const videoId = extractYouTubeId(url);
      if (videoId) {
        songArt.src = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
        songTitle.textContent = 'YouTube Video';
        songArtist.textContent = 'youtube.com';
        songPreview.style.display = 'flex';
        // Try to get actual title via oEmbed
        try {
          const resp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
          if (resp.ok) {
            const data = await resp.json();
            songTitle.textContent = data.title || 'YouTube Video';
            songArtist.textContent = data.author_name || 'YouTube';
          }
        } catch (e) { /* use defaults */ }
        return;
      }
    }

    // Apple Music or Custom — just show green check if URL looks valid
    if (url.startsWith('http')) {
      songArt.src = '';
      songArt.style.display = 'none';
      songTitle.textContent = service === 'apple' ? 'Apple Music Link' : 'Custom Link';
      songArtist.textContent = new URL(url).hostname;
      songPreview.style.display = 'flex';
    } else {
      songPreview.style.display = 'none';
    }
  }

  function extractYouTubeId(url) {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  musicService.addEventListener('change', () => {
    musicUrl.placeholder = servicePlaceholders[musicService.value] || 'Paste a URL...';
  });

  // ── Step 3: Window Entries ─────────────────────────────────────────────
  async function initDisplays() {
    try {
      displays = await window.onix.getDisplays();
    } catch {
      displays = [{ id: 1, name: 'Monitor 1', x: 0, y: 0, width: 1920, height: 1080 }];
    }
    // Seed 1 empty row
    addWindowEntry();
    updateRemoveButtons();
  }

  function addWindowEntry() {
    const count = windowEntries.querySelectorAll('.window-entry').length;
    if (count >= 6) return;

    const row = document.createElement('div');
    row.className = 'window-entry';
    row.innerHTML =
      '<input type="text" class="input-text entry-url" placeholder="Paste a website URL (e.g. https://google.com)">' +
      '<button class="btn-remove" title="Remove">&times;</button>';

    row.querySelector('.btn-remove').addEventListener('click', () => {
      row.remove();
      updateRemoveButtons();
      updateAddButton();
    });

    windowEntries.appendChild(row);
    updateRemoveButtons();
    updateAddButton();
  }

  function updateRemoveButtons() {
    const rows = windowEntries.querySelectorAll('.window-entry');
    rows.forEach((row) => {
      const btn = row.querySelector('.btn-remove');
      btn.style.visibility = rows.length > 1 ? 'visible' : 'hidden';
    });
  }

  function updateAddButton() {
    const count = windowEntries.querySelectorAll('.window-entry').length;
    btnAddWindow.disabled = count >= 6;
  }

  btnAddWindow.addEventListener('click', addWindowEntry);

  // ── Quick Pick Buttons ──────────────────────────────────────────────
  document.querySelectorAll('.quick-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.url;
      // Toggle selection
      btn.classList.toggle('selected');

      if (btn.classList.contains('selected')) {
        // Find an empty row or add a new one
        const rows = windowEntries.querySelectorAll('.window-entry');
        let emptyRow = null;
        rows.forEach(row => {
          const input = row.querySelector('.entry-url');
          if (!input.value.trim()) emptyRow = row;
        });

        if (emptyRow) {
          emptyRow.querySelector('.entry-url').value = url;
        } else {
          addWindowEntry();
          const newRows = windowEntries.querySelectorAll('.window-entry');
          newRows[newRows.length - 1].querySelector('.entry-url').value = url;
        }
      } else {
        // Remove the URL from entries
        const rows = windowEntries.querySelectorAll('.window-entry');
        rows.forEach(row => {
          const input = row.querySelector('.entry-url');
          if (input.value.trim() === url) {
            if (rows.length > 1) {
              row.remove();
              updateRemoveButtons();
              updateAddButton();
            } else {
              input.value = '';
            }
          }
        });
      }
    });
  });

  function collectWindowEntries() {
    const rows = windowEntries.querySelectorAll('.window-entry');
    state.windows = [];
    rows.forEach((row, index) => {
      const url = row.querySelector('.entry-url').value.trim();
      if (url) {
        state.windows.push({ url, monitor: index + 1 });
      }
    });
  }

  // ── Step 4: Calibration & Waveform ─────────────────────────────────────
  const volumeHistory = [];
  const MAX_BARS = 80;

  function drawWaveform(volume) {
    volumeHistory.push(volume);
    if (volumeHistory.length > MAX_BARS) volumeHistory.shift();

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const barWidth = w / MAX_BARS;
    const centerY = h / 2;

    volumeHistory.forEach((v, i) => {
      const barHeight = Math.min(v / 2, 1) * (h * 0.8);
      ctx.fillStyle = '#9FD25D';
      ctx.beginPath();
      const x = i * barWidth + 1;
      const bw = barWidth - 2;
      const r = Math.min(bw / 2, 2);
      const top = centerY - barHeight / 2;
      const bot = centerY + barHeight / 2;

      // Rounded rect for each bar
      ctx.moveTo(x + r, top);
      ctx.lineTo(x + bw - r, top);
      ctx.quadraticCurveTo(x + bw, top, x + bw, top + r);
      ctx.lineTo(x + bw, bot - r);
      ctx.quadraticCurveTo(x + bw, bot, x + bw - r, bot);
      ctx.lineTo(x + r, bot);
      ctx.quadraticCurveTo(x, bot, x, bot - r);
      ctx.lineTo(x, top + r);
      ctx.quadraticCurveTo(x, top, x + r, top);
      ctx.fill();
    });
  }

  function startCalibration() {
    if (calibrationActive) return;
    calibrationActive = true;
    claps = [];
    clapSpectra = [];
    clapFeatures = [];

    // Reset UI
    clapDots.forEach((d) => d.classList.remove('filled'));
    clapValues.forEach((v) => v.textContent = '');
    calibrationPrompt.textContent = 'Clap now';
    calibrationSuccess.classList.add('hidden');
    btnRecalibrate.classList.add('hidden');
    btnFinish.disabled = true;
    // Reset bar colors
    thresholdBar.className = 'threshold-bar';
    thresholdBar.style.width = '0%';
    thresholdMarker.style.left = '0%';

    // Set canvas resolution to match layout size
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = 120 * (window.devicePixelRatio || 1);
    const ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    // Keep the logical draw dimensions
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '120px';
    // Re-assign logical dimensions for drawing
    canvas.width = rect.width;
    canvas.height = 120;

    window.onix.startCalibration();
  }

  // ── Calibration listeners (registered once, gated by calibrationActive) ──
  window.onix.onAudioLevel((volume) => {
    if (!calibrationActive) return;
    drawWaveform(volume);
  });

  window.onix.onCalibrationPeak((peakVolume, spectrum, features) => {
    if (!calibrationActive) return;
    if (claps.length >= 3) return;

    // Guard: previous dot must be filled before accepting next clap
    if (claps.length > 0 && !clapDots[claps.length - 1].classList.contains('filled')) return;

    claps.push(peakVolume);
    if (spectrum) clapSpectra.push(spectrum);
    if (features) clapFeatures.push(features);
    const n = claps.length;

    // Fill dot and show volume value
    clapDots[n - 1].classList.add('filled');
    clapValues[n - 1].textContent = peakVolume.toFixed(2);

    if (n < 3) {
      // Per-clap quality feedback
      let quality;
      if (peakVolume < 1.5) {
        quality = 'a bit soft, clap harder';
      } else if (peakVolume <= 12.0) {
        quality = 'perfect';
      } else {
        quality = 'a bit loud, clap softer';
      }
      calibrationPrompt.textContent = 'Got it (' + n + '/3) \u2014 ' + quality;
      // Brief pause then re-prompt
      setTimeout(() => {
        if (claps.length < 3 && calibrationActive) {
          calibrationPrompt.textContent = 'Clap now';
        }
      }, 1200);
    } else {
      onCalibrationComplete();
    }
  });

  function onCalibrationComplete() {
    const minClap = Math.min(...claps);
    state.threshold = Math.max(minClap * 0.65, 0.3);

    // Compute spectral template (median of 3 spectra, bin by bin)
    if (clapSpectra.length >= 3) {
      const binCount = clapSpectra[0].length;
      const template = new Array(binCount);
      for (let i = 0; i < binCount; i++) {
        const vals = clapSpectra.map(s => s[i]).sort((a, b) => a - b);
        template[i] = vals[1]; // median of 3
      }
      state.spectralTemplate = template;
      // Compute adaptive threshold from how similar the 3 claps are to the template
      const sims = clapSpectra.map(s => compareSpectra(s, template));
      const avgSim = sims.reduce((a, b) => a + b, 0) / sims.length;
      state.spectralThreshold = Math.round(avgSim * 0.80 * 1000) / 1000;
      console.log('[Onboarding] Spectral template computed (' + binCount + ' bins), similarities: [' + sims.map(s => s.toFixed(3)).join(', ') + '], adaptive threshold: ' + state.spectralThreshold);
    } else {
      state.spectralTemplate = null;
      state.spectralThreshold = null;
      console.log('[Onboarding] Not enough spectra for template — skipping');
    }

    // Compute acoustic feature thresholds from the 3 calibration claps
    if (clapFeatures.length >= 3) {
      const flatVals = clapFeatures.map(f => f.flatness).filter(v => v != null);
      const ratioVals = clapFeatures.map(f => f.subBandRatio).filter(v => v != null);
      const crestVals = clapFeatures.map(f => f.crest).filter(v => v != null);

      if (flatVals.length >= 3) {
        state.minFlatness = Math.round(Math.min(...flatVals) * 0.85 * 10000) / 10000;
      }
      if (ratioVals.length >= 3) {
        state.minSubBandRatio = Math.round(Math.min(...ratioVals) * 0.7 * 100) / 100;
        state.maxSubBandRatio = Math.round(Math.max(...ratioVals) * 1.3 * 100) / 100;
      }
      if (crestVals.length >= 3) {
        state.minCrest = Math.round(Math.min(...crestVals) * 0.70 * 100) / 100;
      }

      console.log('[Onboarding] Feature thresholds — flatness>=' + state.minFlatness +
        ', ratio: ' + state.minSubBandRatio + '-' + state.maxSubBandRatio +
        ', crest>=' + state.minCrest +
        ' | raw: flat=[' + flatVals.map(v => v.toFixed(3)).join(',') +
        '], ratio=[' + ratioVals.map(v => v.toFixed(2)).join(',') +
        '], crest=[' + crestVals.map(v => v.toFixed(2)).join(',') + ']');
    } else {
      state.minFlatness = null;
      state.minSubBandRatio = null;
      state.maxSubBandRatio = null;
      state.minCrest = null;
      console.log('[Onboarding] Not enough feature data — acoustic checks disabled');
    }

    calibrationPrompt.textContent = '';
    calibrationSuccess.classList.remove('hidden');
    btnRecalibrate.classList.remove('hidden');

    // Threshold bar visualization (normalize to 0-1 range, cap at 2 for display)
    const displayPct = Math.min((state.threshold / 2) * 100, 100);

    // Color-code based on clap volume (same thresholds as per-clap feedback)
    let barColor, textColor, feedbackMsg;
    if (minClap < 1.5) {
      barColor = 'bar-red';
      textColor = 'text-red';
      feedbackMsg = 'Too soft \u2014 re-calibrate and clap harder';
    } else if (minClap <= 12.0) {
      barColor = 'bar-green';
      textColor = 'text-green';
      feedbackMsg = 'You\'re all set';
    } else {
      barColor = 'bar-orange';
      textColor = 'text-orange';
      feedbackMsg = 'Too loud \u2014 re-calibrate and clap softer';
    }

    successText.textContent = feedbackMsg;
    successText.className = 'success-text ' + textColor;
    thresholdBar.className = 'threshold-bar ' + barColor;

    setTimeout(() => {
      thresholdBar.style.width = displayPct + '%';
      thresholdMarker.style.left = displayPct + '%';
    }, 50);

    btnFinish.disabled = false;
  }

  function stopCalibration() {
    if (!calibrationActive) return;
    calibrationActive = false;
    window.onix.stopCalibration();
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────
  // Pre-fill music URL with default for the initially selected service
  if (!musicUrl.value) {
    musicUrl.value = defaultUrls[musicService.value] || '';
  }
  initMicDevices();
  initDisplays();
});
