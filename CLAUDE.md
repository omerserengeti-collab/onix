# Onix

Onix is a Mac menu bar (tray) app built with Electron that detects double hand claps via the microphone and launches a configured music track + browser windows. It includes onboarding with calibration, a trial/paywall system via LemonSqueezy, and auto-updates via GitHub Releases. The app targets creative professionals who want a hands-free way to set up their workspace.

## Tech Stack

- **Electron** (v33) — main process, tray app, BrowserWindows
- **electron-store** — persistent settings (JSON in `~/Library/Application Support/onix/config.json`)
- **electron-updater** — auto-updates from GitHub Releases
- **Web Audio API** — microphone input, AnalyserNode for clap detection
- **electron-builder** — DMG/NSIS packaging, ad-hoc code signing
- **LemonSqueezy** — license activation API + checkout page

## File Structure

```
main.js              — Main Electron process: tray, windows, IPC, trial/license gate, launch sequence
preload.js           — contextBridge IPC API exposed as window.onix
src/audio/audio.js   — Clap detection algorithm (double-clap pattern, spike duration, ambient noise)
src/audio/audio.html — Hidden audio worker window
src/popup/           — Tray popup: toggle, clap counter, paywall card
src/onboarding/      — 4-step setup: mic check, music, websites, calibration
src/settings/        — Settings page: music, websites, calibration, sensitivity slider
src/paywall/         — Standalone paywall window (unused, paywall is now inline in popup)
src/assets/          — Icons, logo (onix-logo.png, onix.icns)
build/afterPack.js   — Ad-hoc code signing for macOS distribution
```

## What's Working

- Double-clap detection with spike duration filtering (<200ms), ambient noise rejection, and quiet-period gating
- Calibration flow: 3 claps, threshold = min(claps) * 0.75, color-coded feedback bar
- Launch sequence: opens Spotify/YouTube/custom music + Chrome tabs with staggering
- Trial system: 2 free clap-launches, then paywall with LemonSqueezy checkout
- License activation via LemonSqueezy API (live mode)
- Inline paywall in popup with progress steps and license key input
- Settings page: music service, website URLs, sensitivity slider, re-calibration
- Tray icon with context menu
- Auto-update checking via electron-updater + GitHub Releases
- Ad-hoc code signing for distribution without Apple Developer certificate

## What's NOT Done Yet

- **Apple Developer Certificate** ($99/year) — needed for proper code signing, notarization, and seamless auto-updates
- **Launch at login** — toggle exists in settings but may not be fully wired up
- **FFT spectral analysis** — current detection uses only volume level, not frequency; any sharp loud sound can trigger
- **Voice/wake word detection** — planned for v2/v3
- **Windows build** — config exists but untested
- **Apple Music** — hidden from onboarding (card has display:none), AppleScript integration exists but unreliable

## Key Decisions

- **Brand color: #9FD25D** — used for buttons, progress dots, active states, clap dot fills
- **Trial max = 2** — forced via migration on startup (`store.get('trialMax') !== 2` check)
- **Calibration min threshold = 2.0** — volume > 2.0 required to register a calibration clap (filters ambient noise)
- **Detection thresholds**: MAX_SPIKE_DURATION=200ms, AMBIENT_THRESHOLD_RATIO=0.50, quiet period=0.35x threshold
- **Licensed cooldown = 5s** — after a clap-triggered launch, listening resumes in 5 seconds
- **Audio auto-start removed from audio.js** — only main.js controls when listening starts (respects trial/license gate)
- **Popup blur-to-hide** — popup hides on blur unless paywall is showing
- **Post-launch popup** — shown 1.5s after Chrome is brought to front (avoids immediate blur-hide)
- **Post-onboarding start** — listening begins 500ms after onboarding completes
- **Calibration formula**: onboarding uses `min(claps) * 0.75`, settings uses `avg(claps) * 0.7` (known inconsistency)
