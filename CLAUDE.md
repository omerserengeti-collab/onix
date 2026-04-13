# Onix

Onix is a Mac menu bar (tray) app built with Electron that detects double hand claps via the microphone and launches a configured music track + browser windows. It includes onboarding with calibration, a trial/paywall system via LemonSqueezy, and auto-updates via GitHub Releases. The app targets creative professionals who want a hands-free way to set up their workspace.

## Tech Stack

- **Electron** (v33) — main process, tray app, BrowserWindows
- **electron-store** — persistent settings (JSON in `~/Library/Application Support/onix/config.json`)
- **electron-updater** — auto-updates from GitHub Releases
- **Web Audio API** — microphone input, AnalyserNode (FFT 2048, 44100Hz) for clap detection
- **electron-builder** (v26.8.1) — DMG packaging, code signing, notarization
- **LemonSqueezy** — license activation API + checkout page
- **Apple Developer ID** — signed and notarized by KIPIT APPLICATIONS LTD (5M77XYJHJ5)

## File Structure

```
main.js              — Main Electron process: tray, windows, IPC, trial/license gate, launch sequence, Spotify polling
preload.js           — contextBridge IPC API exposed as window.onix
src/audio/audio.js   — Clap detection: double-clap pattern, spike duration, ambient noise, spectral fingerprinting, flatness, sub-band ratio, crest factor
src/audio/audio.html — Hidden audio worker window
src/popup/           — Tray popup: toggle, clap counter, paywall card
src/onboarding/      — 4-step setup: mic check, music, websites, calibration (captures spectral template + acoustic features)
src/settings/        — Settings page: music, websites, calibration, sensitivity slider
src/paywall/         — Standalone paywall window (unused, paywall is now inline in popup)
src/assets/          — Icons, logo (onix-logo.png, onix.icns)
web/                 — Landing page (index.html) hosted separately, download links point to GitHub Releases
build/               — entitlements.mac.plist, entitlements.mac.inherit.plist, afterPack.js (disabled for signed builds)
```

## What's Working

### Clap Detection Pipeline (6 layers)
1. **Volume threshold** — `threshold = min(calibration claps) * 0.65`, clamped to min 0.3
2. **Spike duration** — must be < 200ms (rejects speech, sustained music)
3. **Ambient noise floor** — median of last 60 samples; ambient must be < 50% of threshold. Ambient is preserved across stop/start cycles (not reset on resume)
4. **Quiet period** — volume must drop below 35% of threshold between the two claps
5. **Spectral cosine similarity** — live spectrum captured at spike start, compared to median template from 3 calibration claps (bins 23-372 = 500Hz-8kHz). Adaptive threshold = avgSimilarity of calibration claps * 0.80. Fallback = 0.91
6. **Acoustic feature gates** (all adaptive from calibration, fail-open if missing):
   - **Spectral flatness** (Wiener entropy, 200Hz-8kHz) — high = noise-like (claps), low = tonal (voice/music). Threshold = min(3 claps) * 0.85
   - **Sub-band energy ratio** (2-6kHz / 100-500Hz) — claps are mid-range, knocks too dark, snaps too bright. Threshold = [min * 0.7, max * 1.3]
   - **Crest factor** (peak/RMS from time-domain) — claps have high crest (sharp impulse). Threshold = min(3 claps) * 0.70

### Double-Clap Pattern
- 2 claps required within 1500ms window
- Minimum 200ms gap between claps (echo rejection)
- Must be quiet between claps

### Spotify-Aware Threshold
- Polls Spotify player state every 500ms via AppleScript
- When playing: threshold multiplier = 2.5x (prevents music from triggering)
- Auto-stops after 5 consecutive errors
- Spotify Automation permission warmed up during onboarding completion

### Other Working Features
- Launch sequence: opens Spotify/YouTube/custom music + Chrome tabs with staggering
- Trial system: 2 free clap-launches, then paywall with LemonSqueezy checkout
- License activation via LemonSqueezy API (live mode)
- Inline paywall in popup with progress steps and license key input
- Settings page: music service, website URLs, sensitivity slider, re-calibration
- Tray icon with context menu
- Auto-update checking via electron-updater + GitHub Releases
- Signed and notarized DMG (no Gatekeeper warnings)
- Onboarding window forces itself to front on first launch
- Waveform animation on welcome page
- Default music (Spotify/YouTube) pre-filled with song preview
- Claude pre-selected as default website

## Recent Major Changes

### v1.2.14 — Acoustic Feature Detection
- Added spectral flatness, sub-band energy ratio, crest factor as detection gates
- All thresholds adaptive from user's own 3 calibration claps
- Each feature computed in audio.js, sent through IPC during calibration
- Diagnostic logging: every spike prints sim/flat/ratio/crest values + PASS/REJECT

### v1.2.13 — Spectral Fingerprinting
- FFT spectrum captured at spike start (peak energy frame)
- 3 calibration claps averaged into median template (1024 freq bins)
- Cosine similarity comparison (bins 23-372 = 500Hz-8kHz)
- Adaptive similarity threshold from calibration data
- Bin mismatch detection (rejects old templates after FFT size change)

### v1.2.12 — Detection Improvements
- Removed spectral gating v1 (rise time + centroid — too strict)
- Calibration tolerance: 0.75 -> 0.65 multiplier
- Default music URLs pre-filled in onboarding
- Ambient floor preserved across stop/start (fixed 3s blind window)

### v1.2.15 — Apple Code Signing
- Developer ID Application certificate: KIPIT APPLICATIONS LTD (5M77XYJHJ5)
- Hardened runtime enabled with entitlements (JIT, unsigned memory, dyld env, audio input)
- Notarization via Apple notary service
- DMG also signed
- afterPack.js disabled (was overwriting signature with ad-hoc)

## Key Constants & Settings

| Setting | Value | Location |
|---|---|---|
| Brand color | #9FD25D | CSS everywhere |
| Trial max | 2 clap-launches | main.js migration |
| Licensed cooldown | 5 seconds | main.js |
| FFT_SIZE | 2048 (1024 bins, ~46ms window) | audio.js |
| Sample rate | 44100 Hz | audio.js |
| Bin Hz | ~21.5 Hz/bin | audio.js |
| MAX_SPIKE_DURATION | 200ms | audio.js |
| DOUBLE_CLAP_WINDOW | 1500ms | audio.js |
| CLAP_GAP_MIN | 200ms | audio.js |
| AMBIENT_THRESHOLD_RATIO | 0.50 | audio.js |
| Quiet period | 0.35x threshold | audio.js |
| SPECTRAL_MATCH_THRESHOLD | 0.91 (fallback) | audio.js |
| Spotify threshold multiplier | 2.5x | main.js |
| Spotify poll interval | 500ms | main.js |
| Calibration min volume | 2.0 | audio.js |
| Calibration multiplier | 0.65 (onboarding), 0.70 (settings) | onboarding.js / settings.js |
| Apple Team ID | 5M77XYJHJ5 | package.json |
| Certificate | KIPIT APPLICATIONS LTD | package.json |
| LemonSqueezy | Live mode | main.js |

## What's NOT Done Yet

- **Launch at login** — toggle exists in settings but may not be fully wired up
- **Voice/wake word detection** — planned for v2/v3
- **Windows build** — config exists but untested
- **Apple Music** — hidden from onboarding (card has display:none), AppleScript integration exists but unreliable
- **Universal binary** — currently arm64 only (Apple Silicon). Intel Macs not supported

## How to Build a Signed DMG

### Prerequisites
- Developer ID Application certificate installed in Keychain
- App-specific password from appleid.apple.com

### Commands
```bash
# 1. Unlock keychain (required for codesign access)
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "YOUR_PASSWORD" ~/Library/Keychains/login.keychain-db

# 2. Set notarization credentials
export APPLE_ID="rafizvi@kipit.ai"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="5M77XYJHJ5"

# 3. Build (signs, notarizes, staples automatically)
npm run build

# 4. Verify
codesign -dv --verbose=4 "dist/mac-arm64/Onix.app"
# Should show: Authority=Developer ID Application: KIPIT APPLICATIONS LTD
# Should show: flags=0x10000(runtime)
```

### Release to GitHub + Landing Page
```bash
# Upload DMG to GitHub Release, then update web/index.html download links
# See main.js git history for the exact curl commands used with GitHub API
```

## Claude Chat + Claude Code Workflow

This project uses **two Claude instances** working together:

- **Claude Chat** (chat.anthropic.com) — used for audio engineering research, algorithm design, threshold tuning, and architectural decisions. The user consults Claude Chat for deep technical questions (e.g., spectral flatness values for laptop mics, cosine similarity between claps and speech, FFT window contamination) and brings the answers back to Claude Code for implementation.

- **Claude Code** (this instance) — implements all code changes, builds DMGs, creates GitHub releases, updates the landing page, and maintains this documentation. Claude Code reads files, makes surgical edits, and follows the user's instructions precisely. All builds, commits, and releases are done here.

The user acts as the bridge: researching with Claude Chat, deciding on the approach, then instructing Claude Code to implement it. This workflow allows deep technical exploration without burning Claude Code's context on research.
