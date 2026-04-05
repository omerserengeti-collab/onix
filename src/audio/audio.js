// ─── Configuration ─────────────────────────────────────────
const SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;        // gives us 1024 samples per analysis
const COOLDOWN_MS = 3000;     // 3 seconds between triggers (calibration)
const LAUNCH_COOLDOWN_MS = 30000; // 30 seconds after a launch before listening again
const LEVEL_INTERVAL = 50;    // send level updates every 50ms

// ─── Double-Clap Detection ────────────────────────────────
const DOUBLE_CLAP_WINDOW = 1500;  // 2 claps must happen within 1.5 seconds
const CLAP_GAP_MIN = 200;         // minimum 200ms gap between claps (to avoid echo)
const REQUIRED_CLAPS = 2;         // require 2 claps to trigger

// ─── Ambient Noise Floor ──────────────────────────────────
const AMBIENT_SAMPLES_COUNT = 60; // track ~3 seconds of ambient noise (at 50ms intervals)
const AMBIENT_THRESHOLD_RATIO = 0.35; // ambient must be below 35% of clap threshold

// ─── State ─────────────────────────────────────────────────
let audioContext = null;
let analyser = null;
let sourceNode = null;
let stream = null;
let isListening = false;
let isCalibrating = false;
let threshold = 0.42;
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
const MAX_SPIKE_DURATION = 150; // clap spike must be shorter than 150ms (speech is longer)

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
      if (volume > 0.15 && now - lastTriggerTime > COOLDOWN_MS) {
        lastTriggerTime = now;
        window.onix.sendAudioClap(volume);
      }
    } else if (isListening) {
      // ─── Double-Clap Pattern Detection ─────────────────────

      // Clean up old claps from the pattern window
      clapTimes = clapTimes.filter(t => now - t < DOUBLE_CLAP_WINDOW);

      // Check if volume is above threshold (potential clap)
      const isAboveThreshold = volume > threshold;

      // Check ambient noise floor — if ambient is too high (music playing), ignore
      const ambientOk = ambientLevel < threshold * AMBIENT_THRESHOLD_RATIO;

      // ── Spike sharpness detection ──
      // Claps are VERY short (< 150ms). Speech/music stay above threshold longer.
      if (isAboveThreshold && !inSpike) {
        // Spike just started
        inSpike = true;
        spikeStartTime = now;
      } else if (!isAboveThreshold && inSpike) {
        // Spike just ended — check if it was short enough to be a clap
        const spikeDuration = now - spikeStartTime;
        inSpike = false;

        if (spikeDuration <= MAX_SPIKE_DURATION && wasQuietAfterLastClap && ambientOk) {
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
              ambientSamples = []; // reset ambient tracking
              window.onix.sendAudioClap(volume);
              console.log('[Audio] ✅ DOUBLE CLAP CONFIRMED — triggering launch!');
            }
          }
        } else if (spikeDuration > MAX_SPIKE_DURATION) {
          console.log(`[Audio] Spike ignored — too long (${spikeDuration}ms), likely speech/music`);
        }
      }

      // If spike has been going on too long, it's not a clap — cancel it
      if (inSpike && (now - spikeStartTime) > MAX_SPIKE_DURATION * 2) {
        inSpike = false;
        console.log('[Audio] Long spike cancelled — sustained sound, not a clap');
      }

      // Track quiet periods between claps
      if (!isAboveThreshold && volume < threshold * 0.5) {
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
  ambientSamples = [];
  ambientLevel = 0;
  wasQuietAfterLastClap = true;

  isListening = true;
  startProcessing();
  console.log('[Audio] Listening started, threshold:', threshold, '| Requires', REQUIRED_CLAPS, 'claps within', DOUBLE_CLAP_WINDOW, 'ms');
}

function stopListening() {
  isListening = false;
  clapTimes = [];
  ambientSamples = [];
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

window.onix.onStartCalibration(() => startCalibration());
window.onix.onStopCalibration(() => stopCalibration());

// ─── Auto-start ───────────────────────────────────────────
(async () => {
  const settings = await window.onix.getSettings();
  if (settings.onboardingComplete) {
    // Wait 5 seconds before starting to listen (let the app settle)
    setTimeout(() => {
      startListening();
    }, 5000);
  }
})();
