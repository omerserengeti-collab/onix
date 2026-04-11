// ─── Configuration ─────────────────────────────────────────
const SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;        // 1024 freq bins, ~46ms window
const COOLDOWN_MS = 1500;     // 1.5 seconds between triggers (calibration)
const LAUNCH_COOLDOWN_MS = 30000; // 30 seconds after a launch before listening again
const LEVEL_INTERVAL = 50;    // send level updates every 50ms

// ─── Double-Clap Detection ────────────────────────────────
const DOUBLE_CLAP_WINDOW = 1500;  // 2 claps must happen within 1.5 seconds
const CLAP_GAP_MIN = 200;         // minimum 200ms gap between claps (to avoid echo)
const REQUIRED_CLAPS = 2;         // require 2 claps to trigger

// ─── Ambient Noise Floor ──────────────────────────────────
const AMBIENT_SAMPLES_COUNT = 60; // track ~3 seconds of ambient noise (at 50ms intervals)
const AMBIENT_THRESHOLD_RATIO = 0.50; // ambient must be below 50% of clap threshold

// ─── State ─────────────────────────────────────────────────
let audioContext = null;
let analyser = null;
let sourceNode = null;
let stream = null;
let isListening = false;
let isCalibrating = false;
let threshold = 0.42;
let thresholdMultiplier = 1.0; // dynamically raised when Spotify is playing to avoid false triggers
let lastTriggerTime = 0;
let animFrameId = null;
let levelIntervalId = null;

// Double-clap pattern state
let clapTimes = [];
// Ambient noise tracking
let ambientSamples = [];
let ambientLevel = 0;
// Track if volume was below threshold between claps (ensures distinct claps)
let wasQuietAfterLastClap = true;
// Spike sharpness tracking — claps are very short spikes, speech is sustained
let spikeStartTime = 0;
let inSpike = false;
const MAX_SPIKE_DURATION = 200; // clap spike must be shorter than 200ms (speech is longer)

// ─── Spectral Fingerprinting ─────────────────────────────
const SPECTRAL_MIN_BIN = 23;   // ~500 Hz  (bin = freq / (sampleRate / fftSize), 21.5 Hz/bin)
const SPECTRAL_MAX_BIN = 372;  // ~8000 Hz
const SPECTRAL_MATCH_THRESHOLD = 0.91;
let spectralTemplate = null;   // Float32Array loaded from settings, or null (skip check)
let spectralThreshold = SPECTRAL_MATCH_THRESHOLD; // adaptive, loaded from settings or fallback
let spikeSpectrum = null;      // captured at spike start for comparison at spike end
let spikeTimeData = null;      // time-domain data captured at spike start for crest factor

// ─── Acoustic Feature Thresholds (adaptive, from calibration) ─
const FLATNESS_ANALYSIS_MIN_BIN = 10;  // ~200 Hz
const FLATNESS_ANALYSIS_MAX_BIN = 372; // ~8000 Hz
const SUBBAND_HIGH_MIN = 93;   // ~2000 Hz
const SUBBAND_HIGH_MAX = 279;  // ~6000 Hz
const SUBBAND_LOW_MIN = 5;     // ~100 Hz
const SUBBAND_LOW_MAX = 23;    // ~500 Hz
let minFlatness = null;        // from calibration, or null (skip check)
let minSubBandRatio = null;    // from calibration
let maxSubBandRatio = null;    // from calibration
let minCrest = null;           // from calibration

// ─── Initialize Microphone ────────────────────────────────
async function initMicrophone(deviceId) {
  // Clean up previous stream if switching devices
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  const constraints = {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: SAMPLE_RATE
    }
  };

  // Use specific device if provided
  if (deviceId) {
    constraints.audio.deviceId = { exact: deviceId };
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);

    if (!audioContext) {
      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    }

    sourceNode = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    sourceNode.connect(analyser);

    const track = stream.getAudioTracks()[0];
    console.log('[Audio] Microphone initialized:', track.label, '| sample rate:', audioContext.sampleRate);
    return true;
  } catch (err) {
    console.error('[Audio] Failed to access microphone:', err);
    return false;
  }
}

// ─── Calculate Volume (L2 norm, matches numpy.linalg.norm) ─
function getVolume() {
  if (!analyser) return 0;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);

  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum); // L2 norm — same as numpy.linalg.norm
}

// ─── Spectral Comparison (cosine similarity, 500Hz–8kHz) ──
function compareSpectra(live, template, minBin = SPECTRAL_MIN_BIN, maxBin = SPECTRAL_MAX_BIN) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = minBin; i < maxBin; i++) {
    const a = Math.pow(10, live[i] / 20);
    const b = Math.pow(10, template[i] / 20);
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const divisor = Math.sqrt(normA) * Math.sqrt(normB);
  return divisor === 0 ? 0 : dot / divisor;
}

function captureSpectrum() {
  if (!analyser) return null;
  const freqData = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(freqData);
  return freqData;
}

// ─── Spectral Flatness (Wiener entropy) ──────────────────
// High = noise-like (claps). Low = tonal (voice, music, snaps).
function spectralFlatness(freqData, minBin = FLATNESS_ANALYSIS_MIN_BIN, maxBin = FLATNESS_ANALYSIS_MAX_BIN) {
  let logSum = 0, linSum = 0, count = 0;
  for (let i = minBin; i < maxBin; i++) {
    const mag = Math.pow(10, freqData[i] / 20);
    if (mag > 0) { logSum += Math.log(mag); count++; }
    linSum += mag;
  }
  if (count === 0 || linSum === 0) return 0;
  return Math.exp(logSum / count) / (linSum / count);
}

// ─── Sub-band Energy Ratio (high 2–6kHz / low 100–500Hz) ─
// Claps: mid-range. Knocks: too dark. Snaps: too bright.
function subBandRatio(freqData) {
  let highEnergy = 0, lowEnergy = 0;
  for (let i = SUBBAND_HIGH_MIN; i < SUBBAND_HIGH_MAX; i++) {
    highEnergy += Math.pow(10, freqData[i] / 10); // power (dB → linear power)
  }
  for (let i = SUBBAND_LOW_MIN; i < SUBBAND_LOW_MAX; i++) {
    lowEnergy += Math.pow(10, freqData[i] / 10);
  }
  return lowEnergy === 0 ? 999 : highEnergy / lowEnergy;
}

// ─── Crest Factor (peak / RMS from time-domain data) ─────
// Claps: very high (sharp impulse). Sustained sounds: low.
function crestFactor(timeData) {
  let peak = 0, sum = 0;
  for (let i = 0; i < timeData.length; i++) {
    const abs = Math.abs(timeData[i]);
    if (abs > peak) peak = abs;
    sum += timeData[i] * timeData[i];
  }
  const rms = Math.sqrt(sum / timeData.length);
  return rms === 0 ? 0 : peak / rms;
}

function captureTimeDomain() {
  if (!analyser) return null;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  return data;
}

// ─── Update Ambient Noise Floor ───────────────────────────
function updateAmbientLevel(volume) {
  ambientSamples.push(volume);
  if (ambientSamples.length > AMBIENT_SAMPLES_COUNT) {
    ambientSamples.shift();
  }
  // Use median instead of average to be more resistant to spikes
  const sorted = [...ambientSamples].sort((a, b) => a - b);
  ambientLevel = sorted[Math.floor(sorted.length / 2)];
}

// ─── Audio Processing Loop ────────────────────────────────
function startProcessing() {
  if (levelIntervalId) return;

  levelIntervalId = setInterval(() => {
    if (!isListening && !isCalibrating) return;
    const volume = getVolume();
    window.onix.sendAudioLevel(volume);

    // Update ambient noise tracking (only when listening, not calibrating)
    if (isListening) {
      updateAmbientLevel(volume);
    }
  }, LEVEL_INTERVAL);

  function detectLoop() {
    if (!isListening && !isCalibrating) {
      animFrameId = requestAnimationFrame(detectLoop);
      return;
    }

    const volume = getVolume();
    const now = Date.now();

    if (isCalibrating) {
      // Calibration mode: single clap detection with simple cooldown
      if (volume > 2.0 && now - lastTriggerTime > COOLDOWN_MS) {
        lastTriggerTime = now;
        const spectrum = captureSpectrum();
        const timeData = captureTimeDomain();
        const features = {
          flatness: spectrum ? spectralFlatness(spectrum) : null,
          subBandRatio: spectrum ? subBandRatio(spectrum) : null,
          crest: timeData ? crestFactor(timeData) : null,
        };
        window.onix.sendAudioClap(volume, spectrum ? Array.from(spectrum) : null, features);
      }
    } else if (isListening) {
      // ─── Double-Clap Pattern Detection ─────────────────────

      // Clean up old claps from the pattern window
      clapTimes = clapTimes.filter(t => now - t < DOUBLE_CLAP_WINDOW);

      // Check if volume is above threshold (potential clap)
      const effectiveThreshold = threshold * thresholdMultiplier;
      const isAboveThreshold = volume > effectiveThreshold;

      // Check ambient noise floor — if ambient is too high (music playing), ignore
      const ambientOk = ambientLevel < effectiveThreshold * AMBIENT_THRESHOLD_RATIO;

      // ── Spike sharpness detection ──
      // Claps are VERY short (< 150ms). Speech/music stay above threshold longer.
      if (isAboveThreshold && !inSpike) {
        // Spike just started — capture spectrum NOW (peak energy frame)
        inSpike = true;
        spikeStartTime = now;
        spikeSpectrum = spectralTemplate ? captureSpectrum() : null;
        spikeTimeData = (minCrest !== null) ? captureTimeDomain() : null;
      } else if (!isAboveThreshold && inSpike) {
        // Spike just ended — check if it was short enough to be a clap
        const spikeDuration = now - spikeStartTime;
        inSpike = false;

        // ── Acoustic feature gates (all fail-open if calibration data missing) ──
        let spectralOk = true;
        let flatnessOk = true;
        let ratioOk = true;
        let crestOk = true;

        if (spikeDuration <= MAX_SPIKE_DURATION && wasQuietAfterLastClap && ambientOk) {
          // Spectral similarity
          const similarity = (spectralTemplate && spikeSpectrum) ? compareSpectra(spikeSpectrum, spectralTemplate) : null;
          if (similarity !== null) {
            spectralOk = similarity >= spectralThreshold;
          }

          // Spectral flatness
          let flatVal = null;
          if (minFlatness !== null && spikeSpectrum) {
            flatVal = spectralFlatness(spikeSpectrum);
            flatnessOk = flatVal >= minFlatness;
          }

          // Sub-band energy ratio
          let ratioVal = null;
          if (minSubBandRatio !== null && maxSubBandRatio !== null && spikeSpectrum) {
            ratioVal = subBandRatio(spikeSpectrum);
            ratioOk = ratioVal >= minSubBandRatio && ratioVal <= maxSubBandRatio;
          }

          // Crest factor
          let crestVal = null;
          if (minCrest !== null && spikeTimeData) {
            crestVal = crestFactor(spikeTimeData);
            crestOk = crestVal >= minCrest;
          }

          const allPass = spectralOk && flatnessOk && ratioOk && crestOk;
          console.log(`[Audio] Spike: dur=${spikeDuration}ms, sim=${similarity !== null ? similarity.toFixed(3) : 'N/A'}, flat=${flatVal !== null ? flatVal.toFixed(3) : 'N/A'}, ratio=${ratioVal !== null ? ratioVal.toFixed(2) : 'N/A'}, crest=${crestVal !== null ? crestVal.toFixed(2) : 'N/A'}, result=${allPass ? 'PASS' : 'REJECT'}${!spectralOk ? ' [sim]' : ''}${!flatnessOk ? ' [flat]' : ''}${!ratioOk ? ' [ratio]' : ''}${!crestOk ? ' [crest]' : ''}`);
        }

        if (spikeDuration <= MAX_SPIKE_DURATION && wasQuietAfterLastClap && ambientOk && spectralOk && flatnessOk && ratioOk && crestOk) {
          // This was a sharp, short spike — likely a clap!
          const lastClapTime = clapTimes.length > 0 ? clapTimes[clapTimes.length - 1] : 0;
          const timeSinceLastClap = now - lastClapTime;

          // Ensure minimum gap between claps (avoid counting echo as second clap)
          if (timeSinceLastClap > CLAP_GAP_MIN) {
            clapTimes.push(now);
            wasQuietAfterLastClap = false;

            console.log(`[Audio] Clap ${clapTimes.length}/${REQUIRED_CLAPS} detected (vol: ${volume.toFixed(2)}, duration: ${spikeDuration}ms, ambient: ${ambientLevel.toFixed(3)})`);

            // Check if we have enough claps in the window
            if (clapTimes.length >= REQUIRED_CLAPS) {
              // Double clap detected! Trigger launch
              lastTriggerTime = now;
              clapTimes = []; // reset pattern
              window.onix.sendAudioClap(volume);
              console.log('[Audio] ✅ DOUBLE CLAP CONFIRMED — triggering launch!');
            }
          }
        } else if (spikeDuration > MAX_SPIKE_DURATION) {
          console.log(`[Audio] Spike rejected — too long (${spikeDuration}ms), likely speech/music`);
        }
      }

      // If spike has been going on too long, it's not a clap — cancel it
      if (inSpike && (now - spikeStartTime) > MAX_SPIKE_DURATION * 2) {
        inSpike = false;
        console.log('[Audio] Long spike cancelled — sustained sound, not a clap');
      }

      // Track quiet periods between claps
      if (!isAboveThreshold && volume < effectiveThreshold * 0.35) {
        wasQuietAfterLastClap = true;
      }
    }

    animFrameId = requestAnimationFrame(detectLoop);
  }

  animFrameId = requestAnimationFrame(detectLoop);
}

function stopProcessing() {
  if (levelIntervalId) {
    clearInterval(levelIntervalId);
    levelIntervalId = null;
  }
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

// ─── Start Listening ──────────────────────────────────────
async function startListening() {
  const settings = await window.onix.getSettings();
  threshold = settings.threshold || 0.42;

  // Load spectral template if available (null = skip spectral check)
  if (settings.spectralTemplate && Array.isArray(settings.spectralTemplate)) {
    spectralTemplate = new Float32Array(settings.spectralTemplate);
    console.log('[Audio] Spectral template loaded (' + spectralTemplate.length + ' bins)');
    // Validate bin count matches current FFT config
    if (analyser && spectralTemplate.length !== analyser.frequencyBinCount) {
      console.log('[Audio] Template bin mismatch (' + spectralTemplate.length + ' vs ' + analyser.frequencyBinCount + ') — re-calibration required');
      spectralTemplate = null;
    }
  } else {
    spectralTemplate = null;
    console.log('[Audio] No spectral template — spectral check disabled');
  }
  // Load adaptive spectral threshold (falls back to hardcoded SPECTRAL_MATCH_THRESHOLD)
  spectralThreshold = (settings.spectralThreshold && settings.spectralThreshold > 0) ? settings.spectralThreshold : SPECTRAL_MATCH_THRESHOLD;

  // Load acoustic feature thresholds (null = skip that check)
  minFlatness = (settings.minFlatness != null && settings.minFlatness > 0) ? settings.minFlatness : null;
  minSubBandRatio = (settings.minSubBandRatio != null) ? settings.minSubBandRatio : null;
  maxSubBandRatio = (settings.maxSubBandRatio != null) ? settings.maxSubBandRatio : null;
  minCrest = (settings.minCrest != null && settings.minCrest > 0) ? settings.minCrest : null;

  console.log('[Audio] Thresholds — spectral:', spectralThreshold, '| flatness>=', minFlatness, '| ratio:', minSubBandRatio, '-', maxSubBandRatio, '| crest>=', minCrest);

  // Ensure minimum threshold to avoid false triggers from ambient noise
  if (threshold < 0.3) {
    console.log('[Audio] Threshold too low (' + threshold + '), clamping to 0.3');
    threshold = 0.3;
  }

  const deviceId = settings.micDeviceId || null;

  if (!audioContext || !stream) {
    const ok = await initMicrophone(deviceId);
    if (!ok) return;
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  // Reset all detection state
  lastTriggerTime = Date.now();
  clapTimes = [];
  wasQuietAfterLastClap = true;

  isListening = true;
  startProcessing();
  console.log('[Audio] Listening started, threshold:', threshold, '| Requires', REQUIRED_CLAPS, 'claps within', DOUBLE_CLAP_WINDOW, 'ms');
}

function stopListening() {
  isListening = false;
  clapTimes = [];
  console.log('[Audio] Listening stopped');
}

// ─── Calibration Mode ─────────────────────────────────────
async function startCalibration() {
  const settings = await window.onix.getSettings();
  const deviceId = settings.micDeviceId || null;

  if (!audioContext || !stream) {
    const ok = await initMicrophone(deviceId);
    if (!ok) return;
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  isCalibrating = true;
  lastTriggerTime = 0;
  startProcessing();
  console.log('[Audio] Calibration started');
}

function stopCalibration() {
  isCalibrating = false;
  console.log('[Audio] Calibration stopped');
}

// ─── Device Switch (called when user selects a different mic) ─
window.onix.onSelectAudioDevice(async (deviceId) => {
  console.log('[Audio] Switching to device:', deviceId);
  const ok = await initMicrophone(deviceId);
  if (ok) {
    console.log('[Audio] Device switched successfully');
  }
});

// ─── IPC Event Handlers ───────────────────────────────────
window.onix.onToggleListening((enabled) => {
  if (enabled) startListening();
  else stopListening();
});

window.onix.onSetThresholdMultiplier((m) => {
  thresholdMultiplier = m;
  console.log('[Audio] Threshold multiplier set to', m, '— effective threshold:', (threshold * m).toFixed(2));
});

window.onix.onStartCalibration(() => startCalibration());
window.onix.onStopCalibration(() => stopCalibration());

// ─── Auto-start ───────────────────────────────────────────
// Note: main.js controls when to start listening (checks license/trial).
// Audio worker only starts when it receives toggle-listening from main.js.
// No independent auto-start here to avoid bypassing the trial/license gate.
