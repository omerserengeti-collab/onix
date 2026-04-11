// main.js — Onix Electron main process
// Menu bar app that detects claps via microphone and launches configured apps.

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, systemPreferences, shell, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { exec } = require('child_process');
const zlib = require('zlib');
// ─── Persistent Settings (initialized after app is ready) ────────────────────

let store = null;

function initStore() {
  const Store = require('electron-store');
  store = new Store({
    defaults: {
      music: { service: 'spotify', url: '' },
      windows: [
        { url: '', monitor: 1 },
        { url: '', monitor: 2 }
      ],
      threshold: 0.42,
      launchAtLogin: false,
      showCounter: true,
      onboardingComplete: false,
      clapCount: 0,
      trialClapsUsed: 0,
      trialMax: 2,
      licenseKey: '',
      licenseValid: false
    }
  });

  // Migration: force trialMax to 2
  if (store.get('trialMax') !== 2) {
    store.set('trialMax', 2);
  }
}

// ─── Window & Tray References ───────────────────────────────────────────────────

let tray = null;
let popupWindow = null;
let onboardingWindow = null;
let settingsWindow = null;
let audioWindow = null;
let paywallWindow = null;
let isListening = false;
let isCalibrationMode = false;
let showingPaywall = false;
let suppressBlurHide = false;

// ─── Spotify-aware threshold ─────────────────────────────────────────────────
const SPOTIFY_THRESHOLD_MULTIPLIER = 2.5; // multiply clap threshold while Spotify is playing
const SPOTIFY_POLL_INTERVAL_MS = 500;
const SPOTIFY_MAX_ERRORS = 5;
let spotifyPollInterval = null;
let spotifyPollInFlight = false;
let spotifyErrorCount = 0;
let spotifyLastMultiplier = 1.0;

const preloadPath = path.join(__dirname, 'preload.js');
const paywallPreloadPath = path.join(__dirname, 'src', 'paywall', 'paywall-preload.js');

// ─── CRC32 (required for PNG encoding) ─────────────────────────────────────────

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── Minimal PNG Encoder ────────────────────────────────────────────────────────

function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcData = Buffer.concat([typeBuffer, data]);
  const crcValue = Buffer.alloc(4);
  crcValue.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([length, crcData, crcValue]);
}

function rgbaToPng(width, height, rgbaBuffer) {
  // PNG file signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk data: width, height, bit depth 8, color type 6 (RGBA)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA color type
  ihdr[10] = 0; // deflate compression
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Build raw scanlines: each row is prefixed with a filter byte (0 = None)
  const rowBytes = 1 + width * 4;
  const rawData = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    rawData[y * rowBytes] = 0; // filter: none
    rgbaBuffer.copy(rawData, y * rowBytes + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawData);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// ─── Tray Icon Generation ───────────────────────────────────────────────────────

function createTrayIcon() {
  const trayIconPath = path.join(__dirname, 'src', 'assets', 'tray-icon.png');
  try {
    const img = nativeImage.createFromPath(trayIconPath);
    const resized = img.resize({ width: 22, height: 22 });
    resized.setTemplateImage(true);
    return resized;
  } catch (e) {
    // Fallback: simple programmatic icon
    const size = 22;
    const pixels = Buffer.alloc(size * size * 4, 0);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const d1 = Math.sqrt((x - 8) ** 2 + (y - 12) ** 2);
        const d2 = Math.sqrt((x - 14) ** 2 + (y - 8) ** 2);
        if (d1 < 6 || d2 < 6) {
          pixels[idx] = 0; pixels[idx+1] = 0; pixels[idx+2] = 0; pixels[idx+3] = 255;
        }
      }
    }
    const pngData = rgbaToPng(size, size, pixels);
    const img2 = nativeImage.createFromBuffer(pngData, { width: size, height: size, scaleFactor: 1.0 });
    img2.setTemplateImage(true);
    return img2;
  }
}

// ─── Window Factories ───────────────────────────────────────────────────────────

function createPopupWindow() {
  const trayBounds = tray.getBounds();

  popupWindow = new BrowserWindow({
    width: 344,
    height: 280,
    x: Math.round(trayBounds.x + trayBounds.width / 2 - 172),
    y: trayBounds.y + trayBounds.height,
    frame: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  popupWindow.loadFile(path.join(__dirname, 'src', 'popup', 'popup.html'));

  // Hide when focus is lost — but NOT if paywall is showing
  popupWindow.on('blur', () => {
    if (popupWindow && popupWindow.isVisible() && !showingPaywall && !suppressBlurHide) {
      popupWindow.hide();
    }
  });

  popupWindow.on('closed', () => {
    popupWindow = null;
  });
}

function createOnboardingWindow() {
  onboardingWindow = new BrowserWindow({
    width: 600,
    height: 650,
    center: true,
    title: 'Onix Setup',
    resizable: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  onboardingWindow.loadFile(path.join(__dirname, 'src', 'onboarding', 'onboarding.html'));

  onboardingWindow.on('closed', () => {
    onboardingWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 600,
    height: 500,
    center: true,
    title: 'Onix Settings',
    resizable: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, 'src', 'settings', 'settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    // Show popup after settings closes
    if (popupWindow && !popupWindow.isDestroyed()) {
      const trayBounds = tray.getBounds();
      popupWindow.setPosition(
        Math.round(trayBounds.x + trayBounds.width / 2 - 172),
        trayBounds.y + trayBounds.height
      );
      popupWindow.show();
      popupWindow.focus();
    }
  });
}

function createAudioWindow() {
  audioWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  audioWindow.loadFile(path.join(__dirname, 'src', 'audio', 'audio.html'));

  audioWindow.on('closed', () => {
    audioWindow = null;
  });
}

function createPaywallWindow() {
  if (paywallWindow && !paywallWindow.isDestroyed()) {
    paywallWindow.focus();
    return;
  }

  paywallWindow = new BrowserWindow({
    width: 480,
    height: 520,
    center: true,
    title: 'Onix — License',
    resizable: false,
    webPreferences: {
      preload: paywallPreloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  paywallWindow.loadFile(path.join(__dirname, 'src', 'paywall', 'paywall.html'));

  paywallWindow.on('closed', () => {
    paywallWindow = null;
  });
}

// ─── Tray Setup ─────────────────────────────────────────────────────────────────

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Onix');
  updateTrayMenu();
}

function togglePopup() {
  if (!popupWindow) {
    createPopupWindow();
  }

  if (popupWindow.isVisible()) {
    popupWindow.hide();
  } else {
    // Reposition near the tray icon before showing
    const trayBounds = tray.getBounds();
    popupWindow.setPosition(
      Math.round(trayBounds.x + trayBounds.width / 2 - 172),
      trayBounds.y + trayBounds.height
    );
    popupWindow.show();
    popupWindow.focus();
  }
}

// ─── Trial & License Helpers ────────────────────────────────────────────────────

function isLicensed() {
  return store.get('licenseValid', false);
}

function canUseTrial() {
  const used = store.get('trialClapsUsed', 0);
  const max = store.get('trialMax', 2);
  return used < max;
}

function consumeTrialClap() {
  const used = store.get('trialClapsUsed', 0);
  store.set('trialClapsUsed', used + 1);
}

function showTrialExhaustedNotification() {
  if (Notification.isSupported()) {
    const notif = new Notification({
      title: 'Onix',
      body: "You've used all your free trials. Buy a license to continue.",
      silent: true
    });
    notif.show();
  }
}

// ─── Launch Sequence ────────────────────────────────────────────────────────────

function setThresholdMultiplier(m) {
  if (m === spotifyLastMultiplier) return;
  spotifyLastMultiplier = m;
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.webContents.send('set-threshold-multiplier', m);
  }
}

function startSpotifyPolling() {
  if (spotifyPollInterval) return; // already polling
  spotifyErrorCount = 0;
  console.log('[Onix] Starting Spotify state polling');

  spotifyPollInterval = setInterval(() => {
    if (spotifyPollInFlight) return; // skip if previous call hasn't returned
    spotifyPollInFlight = true;

    const script = 'if application "Spotify" is running then tell application "Spotify" to return player state as string';
    exec(`osascript -e '${script}'`, (err, stdout) => {
      spotifyPollInFlight = false;

      if (err) {
        spotifyErrorCount++;
        if (spotifyErrorCount >= SPOTIFY_MAX_ERRORS) {
          console.log('[Onix] Spotify polling: too many errors, stopping');
          setThresholdMultiplier(1.0);
          stopSpotifyPolling();
        }
        return;
      }

      spotifyErrorCount = 0;
      const state = (stdout || '').trim();
      if (state === 'playing') {
        setThresholdMultiplier(SPOTIFY_THRESHOLD_MULTIPLIER);
      } else {
        // paused, stopped, or Spotify not running
        setThresholdMultiplier(1.0);
      }
    });
  }, SPOTIFY_POLL_INTERVAL_MS);
}

function stopSpotifyPolling() {
  if (spotifyPollInterval) {
    clearInterval(spotifyPollInterval);
    spotifyPollInterval = null;
    console.log('[Onix] Stopped Spotify state polling');
  }
  setThresholdMultiplier(1.0);
}

function launchSequence() {
  const settings = store.store;
  const { music, windows: wins } = settings;

  // t=0: Launch music
  launchMusic(music);

  // Start Spotify-aware threshold polling (only relevant when spotify is the music service)
  if (music.service === 'spotify') {
    startSpotifyPolling();
  }

  // t=3s: Launch browser windows (after Spotify is open), then stagger remaining
  setTimeout(() => {
    if (wins[0] && wins[0].url) {
      launchChrome(wins[0]);
    }

    wins.slice(1).forEach((win, i) => {
      if (win && win.url) {
        setTimeout(() => launchChrome(win), (i + 1) * 1000);
      }
    });

    // After all windows are launched, bring Chrome to front so it's above Spotify
    const totalDelay = Math.max(wins.length * 1000, 1000);
    setTimeout(() => {
      if (process.platform === 'darwin') {
        exec('open -a "Google Chrome"');
      }
      // Show popup above Chrome — macOS requires app.focus({steal:true}) + screen-saver level
      setTimeout(() => {
        if (popupWindow && !popupWindow.isDestroyed()) {
          app.focus({ steal: true });
          popupWindow.setAlwaysOnTop(true, 'screen-saver');
          popupWindow.show();
          popupWindow.moveTop();
          suppressBlurHide = true;
          setTimeout(() => { suppressBlurHide = false; }, 3000);
        }
      }, 1500);
    }, totalDelay);
  }, 3000);
}

function launchMusic(music) {
  if (!music.url) {
    console.log('[Onix] No music URL configured, skipping.');
    return;
  }

  const url = music.url.trim();
  console.log(`[Onix] Launching music: service=${music.service}, url=${url}`);

  if (process.platform === 'darwin') {
    switch (music.service) {
      case 'spotify': {
        // Convert web URL to URI for native app: https://open.spotify.com/track/ABC → spotify:track:ABC
        let spotifyUri = url;
        const webMatch = url.match(/open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/);
        if (webMatch) {
          spotifyUri = `spotify:${webMatch[1]}:${webMatch[2]}`;
        }
        console.log(`[Onix] Spotify URI: ${spotifyUri}`);
        // Open Spotify app first, then play the track
        exec(`open -a Spotify`);
        setTimeout(() => exec(`open "${spotifyUri}"`), 1000);
        break;
      }
      case 'apple': {
        // Convert web URL to music:// for native app
        let musicUri = url;
        if (url.includes('music.apple.com')) {
          musicUri = url.replace('https://music.apple.com', 'music://music.apple.com');
        } else if (!url.startsWith('music://')) {
          musicUri = url; // fallback: open as-is
        }
        console.log(`[Onix] Apple Music URI: ${musicUri}`);
        // Open the specific song URI — this should load the song
        exec(`open "${musicUri}"`);
        // Wait for Apple Music to load the song, then play it
        setTimeout(() => {
          // Use AppleScript to ensure the specific track plays
          const script = `
            tell application "Music"
              activate
              open location "${url}"
              delay 1
              play
            end tell
          `;
          exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
            if (err) {
              console.log('[Onix] AppleScript play fallback:', err.message);
              // Simple fallback
              exec(`osascript -e 'tell application "Music" to play'`);
            }
          });
        }, 2000);
        break;
      }
      case 'youtube':
      case 'custom':
        exec(`open -na "Google Chrome" --args --new-window "${url}"`);
        break;
    }
  } else {
    // Windows (future)
    switch (music.service) {
      case 'spotify': {
        let spotifyUri = url;
        const webMatch = url.match(/open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/);
        if (webMatch) {
          spotifyUri = `spotify:${webMatch[1]}:${webMatch[2]}`;
        }
        exec(`start "" "${spotifyUri}"`);
        break;
      }
      case 'apple':
        exec(`start "" "${url}"`);
        break;
      case 'youtube':
      case 'custom':
        exec(`start chrome --new-window "${url}"`);
        break;
    }
  }
}

function launchChrome(win) {
  const displays = screen.getAllDisplays();
  const display = displays[win.monitor - 1] || displays[0];
  const x = display.bounds.x;
  const y = display.bounds.y;
  exec(`open -na "Google Chrome" --args --new-window --window-position=${x},${y} "${win.url}"`);
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────────

// Settings
ipcMain.handle('get-settings', () => {
  return store.store;
});

ipcMain.handle('save-settings', (_event, key, value) => {
  store.set(key, value);
  return true;
});

ipcMain.handle('save-all-settings', (_event, data) => {
  for (const [key, value] of Object.entries(data)) {
    store.set(key, value);
  }

  // Set launch at login
  if (data.launchAtLogin !== undefined) {
    app.setLoginItemSettings({ openAtLogin: data.launchAtLogin });
  }

  return true;
});

// Displays
ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    name: d.label || `Display ${d.id}`,
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height
  }));
});

// Listening control (from popup toggle)
ipcMain.on('toggle-listening', (_event, enabled) => {
  if (enabled) startListening();
  else stopListening();
});

// Window management
ipcMain.on('open-settings', () => {
  createSettingsWindow();
});

ipcMain.on('close-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.close();
  }
});

ipcMain.handle('get-listening-state', () => isListening);

ipcMain.on('resize-popup', (_event, width, height) => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.setSize(width, height);
  }
});

// Onboarding completion
ipcMain.on('finish-onboarding', (_event, settings) => {
  if (settings) {
    for (const [key, value] of Object.entries(settings)) {
      store.set(key, value);
    }
  }
  store.set('onboardingComplete', true);

  // Warm up macOS Automation permission for Spotify so the OS prompt appears now, not on first clap
  if (settings && settings.music && settings.music.service === 'spotify') {
    exec(`osascript -e 'if application "Spotify" is running then tell application "Spotify" to return player state as string'`, () => {});
  }

  // Stop calibration mode
  isCalibrationMode = false;
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.webContents.send('stop-calibration');
  }

  if (onboardingWindow) {
    onboardingWindow.close();
    onboardingWindow = null;
  }

  // Show tray and start listening (or show paywall if trial exhausted)
  if (!tray) {
    createTray();
  }

  createPopupWindow();
  if (isLicensed() || canUseTrial()) {
    console.log('[Onix] Onboarding complete — starting listening...');
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.show();
      popupWindow.focus();
    }
    setTimeout(() => {
      startListening();
      console.log('[Onix] Now listening for double claps!');
    }, 500);
  } else {
    console.log('[Onix] Onboarding complete — trial exhausted, paywall in popup');
  }
});

// Calibration relay to audio window
ipcMain.on('start-calibration', () => {
  isCalibrationMode = true;
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.webContents.send('start-calibration');
  }
});

ipcMain.on('stop-calibration', () => {
  isCalibrationMode = false;
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.webContents.send('stop-calibration');
  }
});

// Audio device selection — relay to audio window
ipcMain.handle('get-audio-devices', () => {
  return new Promise((resolve) => {
    if (!audioWindow || audioWindow.isDestroyed()) {
      resolve([]);
      return;
    }
    // Ask audio window to enumerate devices and send back
    ipcMain.once('audio-devices-response', (_event, devices) => {
      resolve(devices);
    });
    audioWindow.webContents.send('get-audio-devices');
  });
});

ipcMain.on('select-audio-device', (_event, deviceId) => {
  store.set('micDeviceId', deviceId);
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.webContents.send('select-audio-device', deviceId);
  }
});

// Audio devices response from audio worker
ipcMain.on('audio-devices-response', () => {
  // handled by the once() listener above
});

// Audio data forwarding
ipcMain.on('audio-level', (_event, volume) => {
  // Forward volume level to popup and onboarding windows
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('audio-level', volume);
  }
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.webContents.send('audio-level', volume);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('audio-level', volume);
  }
});

// Clap detected from the audio window
ipcMain.on('audio-clap', (_event, volume, spectrum, features) => {
  if (isCalibrationMode) {
    // During calibration — forward as calibration-peak to onboarding/settings (with spectrum + features)
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.webContents.send('calibration-peak', volume, spectrum, features);
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('calibration-peak', volume, spectrum, features);
    }
    return;
  }

  // ── Trial / License Gate ──────────────────────────────────────────────
  if (isLicensed()) {
    // Licensed user — proceed normally, no limits
    const count = store.get('clapCount', 0) + 1;
    store.set('clapCount', count);

    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('clap-detected', { volume, count });
    }

    stopListening();
    launchSequence();
    console.log('[Onix] Licensed launch! Will resume listening after cooldown.');

    // Auto-resume listening after cooldown
    setTimeout(() => {
      if (isLicensed()) {
        startListening();
        console.log('[Onix] Auto-resumed listening after cooldown.');
      }
    }, 5000); // 5 seconds — quick resume after launch
    return;
  }

  if (canUseTrial()) {
    // Trial available — use it, launch
    consumeTrialClap();
    const count = store.get('clapCount', 0) + 1;
    store.set('clapCount', count);
    const trialUsed = store.get('trialClapsUsed', 0);
    const trialMax = store.get('trialMax', 2);
    const remaining = trialMax - trialUsed;

    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('clap-detected', { volume, count });
      popupWindow.webContents.send('trial-remaining', remaining);
    }

    stopListening();
    launchSequence();
    console.log(`[Onix] Trial clap used! ${remaining} remaining. Launching...`);

    // Quick check — resume listening or show paywall
    setTimeout(() => {
      if (canUseTrial()) {
        // Still has trials — resume listening immediately
        startListening();
        console.log('[Onix] Auto-resumed listening (trial claps remaining).');
      } else {
        // All trials used — show paywall
        showTrialExhaustedNotification();
        showingPaywall = true;
        if (popupWindow && !popupWindow.isDestroyed()) {
          popupWindow.setSize(380, 520);
          popupWindow.webContents.send('show-paywall');
          popupWindow.show();
          popupWindow.focus();
        }
      }
    }, 4000);
    return;
  }

  // Trial exhausted and not licensed — popup shows paywall
  stopListening();
  showingPaywall = true;
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.setSize(380, 520);
    popupWindow.webContents.send('show-paywall');
    popupWindow.show();
    popupWindow.focus();
  }
  console.log('[Onix] Trial exhausted — paywall shown in popup.');
});

// ─── License / Paywall IPC Handlers ─────────────────────────────────────────────

ipcMain.handle('validate-license', async (_event, key) => {
  if (!key || typeof key !== 'string') {
    return { valid: false, message: 'Please enter a license key.' };
  }

  const trimmedKey = key.trim();

  try {
    // Call LemonSqueezy License API to activate the key
    const { net } = require('electron');
    const response = await new Promise((resolve, reject) => {
      const postData = `license_key=${encodeURIComponent(trimmedKey)}&instance_name=Onix`;
      const request = net.request({
        method: 'POST',
        url: 'https://api.lemonsqueezy.com/v1/licenses/activate',
      });
      request.setHeader('Accept', 'application/json');
      request.setHeader('Content-Type', 'application/x-www-form-urlencoded');

      let body = '';
      request.on('response', (res) => {
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Invalid response from server')); }
        });
      });
      request.on('error', (err) => reject(err));
      request.write(postData);
      request.end();
    });

    console.log('[Onix] LemonSqueezy response:', JSON.stringify(response));

    if (response.activated || (response.valid && response.license_key?.status === 'active')) {
      store.set('licenseKey', trimmedKey);
      store.set('licenseValid', true);
      store.set('licenseInstanceId', response.instance?.id || '');
      console.log('[Onix] License activated via LemonSqueezy:', trimmedKey);
      showingPaywall = false;

      // Resize popup back to normal
      if (popupWindow && !popupWindow.isDestroyed()) {
        popupWindow.setSize(344, 280);
      }

      // Close paywall window after a short delay to let UI update
      setTimeout(() => {
        if (paywallWindow && !paywallWindow.isDestroyed()) {
          paywallWindow.close();
          paywallWindow = null;
        }

        // Resume listening
        if (!popupWindow) {
          createPopupWindow();
        }
        startListening();
        console.log('[Onix] License valid — resuming listening');
      }, 1000);

      return { valid: true, message: 'License activated! 🎉' };
    }

    // Handle specific error messages from LemonSqueezy
    const errorMsg = response.error || response.message || 'Invalid license key.';
    return { valid: false, message: errorMsg };

  } catch (err) {
    console.error('[Onix] License validation error:', err);
    return { valid: false, message: 'Could not connect to license server. Check your internet connection.' };
  }
});

ipcMain.handle('buy-license', () => {
  shell.openExternal('https://onixclap.lemonsqueezy.com/checkout/buy/569ae087-31bf-4063-857f-d3ea40f51724');
  return true;
});

// ─── Helpers ────────────────────────────────────────────────────────────────────

function startListening() {
  isListening = true;
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.webContents.send('toggle-listening', true);
  }
  // Update popup and tray menu
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('listening-state', true);
  }
  updateTrayMenu();
  console.log('[Onix] Listening ON');
}

function stopListening() {
  isListening = false;
  if (audioWindow && !audioWindow.isDestroyed()) {
    audioWindow.webContents.send('toggle-listening', false);
  }
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('listening-state', false);
  }
  updateTrayMenu();
  console.log('[Onix] Listening OFF');
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isListening ? '🟢 Listening — ON' : '🔴 Listening — OFF',
      enabled: false
    },
    { type: 'separator' },
    {
      label: isListening ? '⏸ Pause Listening' : '▶ Start Listening',
      click: () => {
        if (isListening) stopListening();
        else startListening();
      }
    },
    { type: 'separator' },
    {
      label: '⚙️ Settings',
      click: () => createSettingsWindow()
    },
    {
      label: '🔄 Re-run Onboarding',
      click: () => {
        store.set('onboardingComplete', false);
        createOnboardingWindow();
      }
    },
    { type: 'separator' },
    {
      label: isLicensed() ? '✅ Licensed' : '🔑 Enter License Key',
      click: () => {
        if (!isLicensed()) {
          createPaywallWindow();
        }
      },
      enabled: !isLicensed()
    },
    { type: 'separator' },
    {
      label: 'Quit Onix',
      click: () => app.quit()
    }
  ]);
  tray.setContextMenu(contextMenu);
}

// ─── Auto-Updater ───────────────────────────────────────────────────────────

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function initAutoUpdater() {
  // Only check for updates in packaged app
  if (!app.isPackaged) {
    console.log('[Onix] Dev mode — skipping auto-update check');
    return;
  }

  autoUpdater.checkForUpdates().catch(err => {
    console.log('[Onix] Update check failed:', err.message);
  });

  // Check again every 30 minutes
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 30 * 60 * 1000);
}

autoUpdater.on('update-available', (info) => {
  console.log('[Onix] Update available:', info.version);
  // Notify popup
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('update-available', info.version);
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[Onix] Update downloaded:', info.version);
  // Notify popup that it's ready to install
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('update-ready', info.version);
  }

  // Show system notification
  if (Notification.isSupported()) {
    const notif = new Notification({
      title: 'Onix Update Ready',
      body: `Version ${info.version} is ready. Restart to install.`,
      silent: true
    });
    notif.on('click', () => {
      autoUpdater.quitAndInstall(false, true);
    });
    notif.show();
  }
});

autoUpdater.on('error', (err) => {
  console.log('[Onix] Auto-update error:', err.message);
});

// IPC: user clicks "Restart & Update"
ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

// ─── App Lifecycle ──────────────────────────────────────────────────────────────

app.on('ready', async () => {
  console.log('[Onix] App ready');

  // Initialize settings store
  initStore();
  console.log('[Onix] Store initialized');

  // Sync launch at login setting with OS
  const loginSettings = app.getLoginItemSettings();
  store.set('launchAtLogin', loginSettings.openAtLogin);

  // Set app icon in dock
  const appIcon = nativeImage.createFromPath(path.join(__dirname, 'src', 'assets', 'onix.icns'));
  if (process.platform === 'darwin' && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }
  console.log('[Onix] App visible in dock');

  // Microphone permission: handled by getUserMedia in the audio worker window.
  // askForMediaAccess causes SIGABRT when running un-bundled, so we skip it here.
  // The packaged .app will trigger the macOS permission popup via getUserMedia.
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log(`[Onix] Mic permission status: ${micStatus}`);
    if (micStatus === 'granted') {
      console.log('[Onix] Mic already granted');
    } else if (app.isPackaged) {
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        console.log(`[Onix] Mic permission ${granted ? 'GRANTED' : 'DENIED'}`);
      } catch (err) {
        console.log('[Onix] Mic permission error:', err.message);
      }
    } else {
      console.log('[Onix] Dev mode — mic permission will be requested by audio worker');
    }
  }

  // Check for updates
  initAutoUpdater();

  console.log('[Onix] Creating audio window...');
  // Always create the audio window (it captures the microphone)
  createAudioWindow();
  console.log('[Onix] Audio window created');

  if (store.get('onboardingComplete')) {
    // User has completed setup
    createTray();

    createPopupWindow();
    if (isLicensed()) {
      startListening();
      console.log('[Onix] Licensed user — listening');
    } else if (canUseTrial()) {
      startListening();
      console.log('[Onix] Trial available — listening');
    } else {
      console.log('[Onix] Trial exhausted — paywall in popup');
    }
  } else {
    // First launch — show onboarding wizard
    createTray();
    createOnboardingWindow();
  }
});

// Keep the app running when all visible windows are closed (menu bar app)
app.on('window-all-closed', (e) => {
  // Do not quit — tray keeps the app alive
});

app.on('before-quit', () => {
  stopSpotifyPolling();
});

app.on('activate', () => {
  // macOS: re-show popup if tray exists
  if (tray) {
    togglePopup();
  }
});
