// preload.js — Onix context bridge
// Exposes a safe API from the main process to all renderer windows.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onix', {
  // ── Settings ────────────────────────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (key, value) => ipcRenderer.invoke('save-settings', key, value),
  saveAllSettings: (data) => ipcRenderer.invoke('save-all-settings', data),
  getDisplays: () => ipcRenderer.invoke('get-displays'),

  // ── Listening Control ───────────────────────────────────────────────────────
  toggleListening: (enabled) => ipcRenderer.send('toggle-listening', enabled),
  getListeningState: () => ipcRenderer.invoke('get-listening-state'),

  // ── Window Management ─────────────────────────────────────────────────────
  openSettings: () => ipcRenderer.send('open-settings'),
  closeWindow: () => ipcRenderer.send('close-window'),
  resizePopup: (width, height) => ipcRenderer.send('resize-popup', width, height),
  finishOnboarding: (settings) => ipcRenderer.send('finish-onboarding', settings),

  // ── Calibration ─────────────────────────────────────────────────────────────
  startCalibration: () => ipcRenderer.send('start-calibration'),
  stopCalibration: () => ipcRenderer.send('stop-calibration'),

  // ── Audio Devices ─────────────────────────────────────────────────────────
  getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),
  selectAudioDevice: (deviceId) => ipcRenderer.send('select-audio-device', deviceId),

  // ── Audio (sent from the audio worker window to main) ─────────────────────
  sendAudioLevel: (volume) => ipcRenderer.send('audio-level', volume),
  sendAudioClap: (volume) => ipcRenderer.send('audio-clap', volume),

  // ── Events from Main Process ──────────────────────────────────────────────
  onClapDetected: (callback) => ipcRenderer.on('clap-detected', (_event, data) => callback(data)),
  onListeningState: (callback) => ipcRenderer.on('listening-state', (_event, enabled) => callback(enabled)),
  onAudioLevel: (callback) => ipcRenderer.on('audio-level', (_event, volume) => callback(volume)),
  onCalibrationPeak: (callback) => ipcRenderer.on('calibration-peak', (_event, volume) => callback(volume)),
  onStartCalibration: (callback) => ipcRenderer.on('start-calibration', () => callback()),
  onStopCalibration: (callback) => ipcRenderer.on('stop-calibration', () => callback()),
  onToggleListening: (callback) => ipcRenderer.on('toggle-listening', (_event, enabled) => callback(enabled)),
  onSelectAudioDevice: (callback) => ipcRenderer.on('select-audio-device', (_event, deviceId) => callback(deviceId)),
  onAudioDevicesResult: (callback) => ipcRenderer.on('audio-devices-result', (_event, devices) => callback(devices)),

  // ── License / Paywall ────────────────────────────────────────────────────
  validateLicense: (key) => ipcRenderer.invoke('validate-license', key),
  buyLicense: () => ipcRenderer.invoke('buy-license'),
  onShowPaywall: (callback) => ipcRenderer.on('show-paywall', () => callback()),
  onCountdownStart: (callback) => ipcRenderer.on('countdown-start', (_event, seconds) => callback(seconds)),

  // ── Auto-Update ─────────────────────────────────────────────────────────
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_event, version) => callback(version)),
  onUpdateReady: (callback) => ipcRenderer.on('update-ready', (_event, version) => callback(version)),
  installUpdate: () => ipcRenderer.send('install-update'),

  // ── Listener Cleanup ──────────────────────────────────────────────────────
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
