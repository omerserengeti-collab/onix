document.addEventListener('DOMContentLoaded', async () => {
  // State
  let settings = {};
  let displays = [];
  let calibrating = false;
  let clapCount = 0;
  let calibrationPeaks = [];
  let audioAnimationId = null;
  let currentAudioLevel = 0;

  // DOM refs
  const closeBtn = document.getElementById('back-btn');
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const saveBtn = document.getElementById('save-btn');

  // Music
  const musicService = document.getElementById('music-service');
  const musicUrl = document.getElementById('music-url');

  // Apps
  const windowEntries = document.getElementById('window-entries');
  const addWindowBtn = document.getElementById('add-window-btn');

  // Calibration
  const currentThresholdEl = document.getElementById('current-threshold');
  const newThresholdEl = document.getElementById('new-threshold');
  const recalibrateBtn = document.getElementById('recalibrate-btn');
  const cancelCalibrationBtn = document.getElementById('cancel-calibration-btn');
  const calibrationDoneBtn = document.getElementById('calibration-done-btn');
  const calibrationIdle = document.getElementById('calibration-idle');
  const calibrationActive = document.getElementById('calibration-active');
  const calibrationDone = document.getElementById('calibration-done');
  const calibrationPrompt = document.getElementById('calibration-prompt');
  const waveformCanvas = document.getElementById('waveform-canvas');
  const waveformCanvasActive = document.getElementById('waveform-canvas-active');

  // General
  const launchAtLogin = document.getElementById('launch-at-login');
  const sensitivitySlider = document.getElementById('sensitivity-slider');
  const sensitivityValue = document.getElementById('sensitivity-value');
  const showCounter = document.getElementById('show-counter');
  const resetCounterBtn = document.getElementById('reset-counter-btn');
  const resetAllBtn = document.getElementById('reset-all-btn');

  // ── Tab Switching (set up FIRST, before async init) ─────────────────

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById('tab-' + tab.dataset.tab);
      if (target) target.classList.add('active');

      // Start waveform when calibration tab is shown
      if (tab.dataset.tab === 'calibration' && waveformCanvas) {
        setTimeout(() => startWaveform(waveformCanvas), 50);
      }
    });
  });

  // ── Init ──────────────────────────────────────────────────────────────

  try {
    settings = await window.onix.getSettings();
    displays = await window.onix.getDisplays();
  } catch (e) {
    console.error('Failed to load settings or displays', e);
  }

  populateMusic();
  populateApps();
  populateCalibration();
  populateGeneral();
  // Don't start waveform here — canvas is hidden. Start when calibration tab is opened.

  // ── Close ─────────────────────────────────────────────────────────────

  closeBtn.addEventListener('click', () => {
    window.onix.closeWindow();
  });

  // ── Music Tab ─────────────────────────────────────────────────────────

  const placeholders = {
    spotify: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    apple: 'https://music.apple.com/album/...',
    youtube: 'https://youtube.com/watch?v=...',
    custom: 'https://example.com/stream'
  };

  function populateMusic() {
    if (settings.music) {
      musicService.value = settings.music.service || 'spotify';
      musicUrl.value = settings.music.url || '';
    }
    updateMusicPlaceholder();
    syncServiceCards();
    // Show preview if URL already exists
    if (musicUrl.value) {
      setTimeout(() => fetchPreview(musicUrl.value.trim()), 300);
    }
  }

  function updateMusicPlaceholder() {
    musicUrl.placeholder = placeholders[musicService.value] || placeholders.custom;
  }

  musicService.addEventListener('change', updateMusicPlaceholder);

  // ── Service Card Selection ──────────────────────────────────────────
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
      if (songPreview) songPreview.style.display = 'none';
    });
  });

  // Sync cards with loaded settings
  function syncServiceCards() {
    const current = musicService.value;
    serviceCards.forEach(c => {
      c.classList.toggle('selected', c.dataset.service === current);
    });
    musicUrl.placeholder = servicePlaceholders[current] || 'Paste a URL...';
  }

  // oEmbed preview
  musicUrl.addEventListener('input', () => {
    if (previewTimeout) clearTimeout(previewTimeout);
    previewTimeout = setTimeout(() => fetchPreview(musicUrl.value.trim()), 600);
  });

  async function fetchPreview(url) {
    if (!url || !songPreview) { if (songPreview) songPreview.style.display = 'none'; return; }
    const service = musicService.value;

    if (service === 'spotify' && url.includes('spotify.com')) {
      try {
        const resp = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
        if (resp.ok) {
          const data = await resp.json();
          songArt.src = data.thumbnail_url || '';
          songArt.style.display = data.thumbnail_url ? 'block' : 'none';
          songTitle.textContent = data.title || 'Unknown Track';
          songArtist.textContent = data.provider_name || 'Spotify';
          songPreview.style.display = 'flex';
          return;
        }
      } catch (e) { /* fallback below */ }
    }

    if (service === 'youtube' && (url.includes('youtube.com') || url.includes('youtu.be'))) {
      const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
      if (match) {
        songArt.src = `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg`;
        songArt.style.display = 'block';
        songTitle.textContent = 'YouTube Video';
        songArtist.textContent = 'youtube.com';
        songPreview.style.display = 'flex';
        try {
          const resp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
          if (resp.ok) {
            const data = await resp.json();
            songTitle.textContent = data.title || 'YouTube Video';
            songArtist.textContent = data.author_name || 'YouTube';
          }
        } catch (e) {}
        return;
      }
    }

    if (url.startsWith('http')) {
      try {
        songArt.style.display = 'none';
        songTitle.textContent = service === 'apple' ? 'Apple Music Link' : 'Custom Link';
        songArtist.textContent = new URL(url).hostname;
        songPreview.style.display = 'flex';
      } catch (e) { songPreview.style.display = 'none'; }
    } else {
      songPreview.style.display = 'none';
    }
  }

  // ── Apps Tab ──────────────────────────────────────────────────────────

  function populateApps() {
    windowEntries.innerHTML = '';
    const windows = settings.windows || [{ url: '', monitor: 1 }];
    windows.forEach(w => addWindowEntry(w.url, w.monitor));
    updateAddButton();
  }

  function addWindowEntry(url = '', monitor = 1) {
    const entry = document.createElement('div');
    entry.className = 'window-entry';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'https://example.com';
    urlInput.value = url;

    const monitorSelect = document.createElement('select');
    displays.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name || ('Display ' + d.id);
      monitorSelect.appendChild(opt);
    });
    if (displays.length === 0) {
      const opt = document.createElement('option');
      opt.value = 1;
      opt.textContent = 'Display 1';
      monitorSelect.appendChild(opt);
    }
    monitorSelect.value = monitor;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '\u00D7';
    removeBtn.addEventListener('click', () => {
      if (windowEntries.children.length > 1) {
        entry.remove();
        updateAddButton();
      }
    });

    entry.appendChild(urlInput);
    entry.appendChild(monitorSelect);
    entry.appendChild(removeBtn);
    windowEntries.appendChild(entry);
  }

  function updateAddButton() {
    addWindowBtn.disabled = windowEntries.children.length >= 6;
  }

  addWindowBtn.addEventListener('click', () => {
    if (windowEntries.children.length < 6) {
      addWindowEntry();
      updateAddButton();
    }
  });

  // ── Calibration Tab ───────────────────────────────────────────────────

  function populateCalibration() {
    const threshold = settings.threshold || 0.42;
    currentThresholdEl.textContent = threshold.toFixed(2);
  }

  recalibrateBtn.addEventListener('click', () => {
    calibrating = true;
    clapCount = 0;
    calibrationPeaks = [];
    calibrationIdle.style.display = 'none';
    calibrationDone.style.display = 'none';
    calibrationActive.style.display = 'block';
    updateClapDots();
    calibrationPrompt.textContent = 'Clap 3 times. Waiting for claps...';
    window.onix.startCalibration();
    startWaveform(waveformCanvasActive);
  });

  cancelCalibrationBtn.addEventListener('click', () => {
    calibrating = false;
    window.onix.stopCalibration();
    calibrationActive.style.display = 'none';
    calibrationIdle.style.display = 'block';
  });

  calibrationDoneBtn.addEventListener('click', () => {
    calibrating = false;
    window.onix.stopCalibration();
    calibrationDone.style.display = 'none';
    calibrationIdle.style.display = 'block';
    populateCalibration();
  });

  function updateClapDots() {
    for (let i = 0; i < 3; i++) {
      const dot = document.getElementById('dot-' + i);
      if (dot) {
        dot.classList.toggle('filled', i < clapCount);
      }
    }
  }

  window.onix.onCalibrationPeak((peak) => {
    if (!calibrating) return;
    clapCount++;
    calibrationPeaks.push(peak);
    updateClapDots();
    calibrationPrompt.textContent = `Clap ${clapCount} of 3 detected!`;

    if (clapCount >= 3) {
      calibrating = false;
      const avgPeak = calibrationPeaks.reduce((a, b) => a + b, 0) / calibrationPeaks.length;
      const newThreshold = Math.round(avgPeak * 0.7 * 100) / 100;
      settings.threshold = newThreshold;
      newThresholdEl.textContent = newThreshold.toFixed(2);
      currentThresholdEl.textContent = newThreshold.toFixed(2);

      // Update sensitivity slider range
      updateSensitivityRange(newThreshold);

      setTimeout(() => {
        calibrationActive.style.display = 'none';
        calibrationDone.style.display = 'block';
      }, 500);
    }
  });

  // ── Waveform Drawing ──────────────────────────────────────────────────

  window.onix.onAudioLevel((level) => {
    currentAudioLevel = level;
  });

  function startWaveform(canvas) {
    if (!canvas || canvas.clientWidth === 0) return; // skip if hidden
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);

    const barCount = 40;
    const barWidth = (canvas.clientWidth / barCount) * 0.6;
    const gap = (canvas.clientWidth / barCount) * 0.4;
    const centerY = canvas.clientHeight / 2;
    const bars = new Array(barCount).fill(0);

    function draw() {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

      // Shift bars left, add new value on right
      bars.shift();
      bars.push(currentAudioLevel);

      for (let i = 0; i < barCount; i++) {
        const value = bars[i];
        const height = Math.max(2, value * canvas.clientHeight * 0.8);
        const x = i * (barWidth + gap) + gap / 2;

        ctx.fillStyle = value > (settings.threshold || 0.42) ? '#9FD25D' : '#444';
        ctx.beginPath();
        ctx.roundRect(x, centerY - height / 2, barWidth, height, 2);
        ctx.fill();
      }

      audioAnimationId = requestAnimationFrame(draw);
    }

    if (audioAnimationId) cancelAnimationFrame(audioAnimationId);
    draw();
  }

  // ── General Tab ───────────────────────────────────────────────────────

  function populateGeneral() {
    launchAtLogin.checked = settings.launchAtLogin || false;
    showCounter.checked = settings.showCounter !== undefined ? settings.showCounter : true;

    const threshold = settings.threshold || 0.42;
    updateSensitivityRange(threshold);
  }

  function updateSensitivityRange(threshold) {
    const min = Math.round(threshold * 0.5 * 100) / 100;
    const max = Math.round(threshold * 1.5 * 100) / 100;
    sensitivitySlider.min = min;
    sensitivitySlider.max = max;
    sensitivitySlider.step = 0.01;
    sensitivitySlider.value = threshold;
    sensitivityValue.textContent = threshold.toFixed(2);
  }

  sensitivitySlider.addEventListener('input', () => {
    const val = parseFloat(sensitivitySlider.value);
    sensitivityValue.textContent = val.toFixed(2);
    settings.threshold = val;
  });

  resetCounterBtn.addEventListener('click', () => {
    if (confirm('Reset the clap counter to 0?')) {
      settings.clapCount = 0;
    }
  });

  resetAllBtn.addEventListener('click', () => {
    if (confirm('This will reset all settings to defaults. Are you sure?')) {
      settings = {
        music: { service: 'spotify', url: '' },
        windows: [{ url: '', monitor: 1 }],
        threshold: 0.42,
        launchAtLogin: false,
        showCounter: true,
        onboardingComplete: false,
        clapCount: 0
      };
      window.onix.saveAllSettings(settings);
      window.onix.closeWindow();
    }
  });

  // ── Save ──────────────────────────────────────────────────────────────

  saveBtn.addEventListener('click', () => {
    // Collect music
    settings.music = {
      service: musicService.value,
      url: musicUrl.value
    };

    // Collect windows
    const entries = windowEntries.querySelectorAll('.window-entry');
    settings.windows = Array.from(entries).map(entry => {
      const urlInput = entry.querySelector('input[type="text"]');
      const monitorSelect = entry.querySelector('select');
      return {
        url: urlInput.value,
        monitor: parseInt(monitorSelect.value, 10)
      };
    });

    // Collect general
    settings.launchAtLogin = launchAtLogin.checked;
    settings.showCounter = showCounter.checked;
    settings.threshold = parseFloat(sensitivitySlider.value);

    // Save
    window.onix.saveAllSettings(settings);

    // Flash button green
    saveBtn.textContent = 'Saved!';
    saveBtn.classList.add('saved');

    setTimeout(() => {
      saveBtn.textContent = 'Save Changes';
      saveBtn.classList.remove('saved');
      window.onix.closeWindow();
    }, 500);
  });
});
