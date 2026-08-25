// Stack-chan Config Editor — Frontend Logic

const statusDiv = document.getElementById('status');
const errorDiv = document.getElementById('error');

function showStatus(msg) {
  statusDiv.textContent = msg;
  errorDiv.textContent = '';
}
function showError(msg) {
  errorDiv.textContent = msg;
  statusDiv.textContent = '';
}

// Collect all form fields into a flat env config object
function collectConfig() {
  const config = {};
  // Backend
  const backend = document.getElementById('backend').value;
  config['STACKCHAN_BACKEND'] = backend === '1' ? 'hermes' : 'openclaw';
  // OpenClaw
  config['OPENCLAW_HOST'] = val('oc_host');
  config['OPENCLAW_PORT'] = val('oc_port') || '18789';
  config['OPENCLAW_MODEL'] = val('oc_model');
  config['OPENCLAW_AGENT_ID'] = val('oc_agent_id');
  config['OPENCLAW_API_KEY'] = val('oc_api_key');
  // TTS
  config['STACKCHAN_LOCAL_TTS_URL'] = val('tts_url');
  // STT
  config['HERMES_STT_URL'] = val('stt_url');
  config['HERMES_STT_MODEL'] = val('stt_model');
  // VAD
  config['STACKCHAN_VAD_RMS_THRESHOLD'] = val('vad_rms');
  config['STACKCHAN_VAD_START_SPEECH_MS'] = val('vad_start');
  config['STACKCHAN_VAD_END_SILENCE_MS'] = val('vad_end');
  config['STACKCHAN_VAD_MIN_SPEECH_MS'] = val('vad_min');
  // Fast ack
  config['STACKCHAN_FAST_ACK_ENABLED'] = document.getElementById('fast_ack').checked ? 'true' : 'false';
  config['STACKCHAN_FAST_ACK_TEXT'] = val('fast_ack_text');
  config['STACKCHAN_FAST_ACK_TEXTS'] = val('fast_ack_text');
  // Standby
  config['STACKCHAN_STANDBY_PHRASES'] = val('standby_phrases');
  config['STACKCHAN_STANDBY_ACK_TEXT'] = val('standby_ack');
  // TTS streaming
  config['STACKCHAN_MAX_SPEECH_CHARS'] = val('max_chars');
  config['STACKCHAN_TTS_SEGMENT_MAX_CHARS'] = val('seg_chars');
  config['STACKCHAN_TTS_OUTPUT_GAIN'] = val('tts_gain');
  // Behaviour
  config['STACKCHAN_AUTO_RESUME_LISTENING'] = document.getElementById('auto_resume').checked ? 'true' : 'false';
  config['STACKCHAN_AUTO_LED_ENABLED'] = document.getElementById('auto_led').checked ? 'true' : 'false';
  config['STACKCHAN_BOOT_VOLUME'] = val('boot_volume');
  // Reply prefix
  config['STACKCHAN_REPLY_PROMPT_PREFIX'] = val('reply_prefix');
  return config;
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined && value !== null) {
    el.value = value;
  }
}

// Populate form from flat env config object
function populateConfig(config) {
  if (!config) return;
  // Backend
  const backend = config['STACKCHAN_BACKEND'] || 'openclaw';
  document.getElementById('backend').value = backend === 'hermes' ? '1' : '0';
  // OpenClaw
  setVal('oc_host', config['OPENCLAW_HOST'] || '127.0.0.1');
  setVal('oc_port', config['OPENCLAW_PORT'] || '18789');
  setVal('oc_model', config['OPENCLAW_MODEL'] || '');
  setVal('oc_agent_id', config['OPENCLAW_AGENT_ID'] || '');
  setVal('oc_api_key', config['OPENCLAW_API_KEY'] || '');
  // TTS
  setVal('tts_url', config['STACKCHAN_LOCAL_TTS_URL'] || '');
  // STT
  setVal('stt_url', config['HERMES_STT_URL'] || '');
  setVal('stt_model', config['HERMES_STT_MODEL'] || 'whisper-1');
  // VAD
  setVal('vad_rms', config['STACKCHAN_VAD_RMS_THRESHOLD'] || '0.045');
  setVal('vad_start', config['STACKCHAN_VAD_START_SPEECH_MS'] || '180');
  setVal('vad_end', config['STACKCHAN_VAD_END_SILENCE_MS'] || '800');
  setVal('vad_min', config['STACKCHAN_VAD_MIN_SPEECH_MS'] || '150');
  // Fast ack
  document.getElementById('fast_ack').checked = config['STACKCHAN_FAST_ACK_ENABLED'] === 'true';
  setVal('fast_ack_text', config['STACKCHAN_FAST_ACK_TEXT'] || 'Yes, darling?');
  // Standby
  setVal('standby_phrases', config['STACKCHAN_STANDBY_PHRASES'] || 'quiet rosie');
  setVal('standby_ack', config['STACKCHAN_STANDBY_ACK_TEXT'] || 'Going quiet, darling.');
  // TTS streaming
  setVal('max_chars', config['STACKCHAN_MAX_SPEECH_CHARS'] || '800');
  setVal('seg_chars', config['STACKCHAN_TTS_SEGMENT_MAX_CHARS'] || '120');
  setVal('tts_gain', config['STACKCHAN_TTS_OUTPUT_GAIN'] || '0.65');
  // Behaviour
  document.getElementById('auto_resume').checked = config['STACKCHAN_AUTO_RESUME_LISTENING'] === 'true';
  document.getElementById('auto_led').checked = config['STACKCHAN_AUTO_LED_ENABLED'] === 'true';
  setVal('boot_volume', config['STACKCHAN_BOOT_VOLUME'] || '70');
  // Reply prefix
  setVal('reply_prefix', config['STACKCHAN_REPLY_PROMPT_PREFIX'] || '');
}

// Load from .env (on the Mac, via config-editor API)
async function loadFromEnv() {
  showStatus('Loading from .env...');
  try {
    const res = await fetch('/api/config');
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    populateConfig(data.config);
    showStatus('Config loaded from .env ✓');
  } catch (e) {
    showError('Load failed: ' + e.message);
  }
}

// Save to .env
async function saveToEnv() {
  const config = collectConfig();
  showStatus('Saving to .env...');
  try {
    const res = await fetch('/api/config_set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
    showStatus('Saved to .env ✓ — click "Restart ai-server" to apply changes');
  } catch (e) {
    showError('Save failed: ' + e.message);
  }
}

// Restart ai-server
async function restartServer() {
  showStatus('Restarting ai-server...');
  try {
    const res = await fetch('/api/restart', { method: 'POST' });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
    if (result.ok) {
      showStatus('ai-server restarted ✓ (PID ' + result.pid + ')');
    } else {
      showStatus(result.message || 'Restart attempted — check logs');
    }
  } catch (e) {
    showError('Restart failed: ' + e.message);
  }
}

// Wire up buttons
document.getElementById('loadBtn').addEventListener('click', loadFromEnv);
document.getElementById('saveBtn').addEventListener('click', saveToEnv);
document.getElementById('restartBtn').addEventListener('click', restartServer);
document.getElementById('saveBtn2').addEventListener('click', saveToEnv);
document.getElementById('restartBtn2').addEventListener('click', restartServer);

// ---- Live Controls: Volume ----
const volumeSlider = document.getElementById('volume');
const volumeVal = document.getElementById('volumeVal');

function updateVolumeFill() {
  const v = Number(volumeSlider.value);
  volumeVal.textContent = v + '%';
  volumeSlider.style.setProperty('--fill', v + '%');
}
volumeSlider.addEventListener('input', updateVolumeFill);

// Sync volume slider with boot_volume field
const bootVolumeInput = document.getElementById('boot_volume');
bootVolumeInput.addEventListener('input', () => {
  volumeSlider.value = bootVolumeInput.value;
  updateVolumeFill();
});

async function applyVolume() {
  const volume = Number(volumeSlider.value);
  showStatus('Setting volume to ' + volume + '%...');
  try {
    const res = await fetch('/api/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || ('HTTP ' + res.status));
    bootVolumeInput.value = String(volume);
    showStatus('Volume set to ' + volume + '% ✓ (also saved as boot volume)');
  } catch (e) {
    showError('Volume failed: ' + e.message);
  }
}

document.getElementById('volumeBtn').addEventListener('click', applyVolume);

// ---- Live Controls: Test Tone ----
async function playTone() {
  showStatus('Playing test tone...');
  try {
    const res = await fetch('/api/tone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || ('HTTP ' + res.status));
    showStatus('Test tone played ✓');
  } catch (e) {
    showError('Tone failed: ' + e.message);
  }
}

document.getElementById('toneBtn').addEventListener('click', playTone);

// Load config on startup
loadFromEnv();