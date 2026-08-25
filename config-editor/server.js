const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
const PORT = 5570;

// Parse CLI args
const args = process.argv.slice(2);
let robotIp = '';
const ipArgIdx = args.indexOf('--robot-ip');
if (ipArgIdx !== -1 && args[ipArgIdx + 1]) {
  robotIp = args[ipArgIdx + 1];
}

// Path to the ai-server .env (the real source of truth for config)
const ENV_PATH = path.resolve(__dirname, '..', 'ai-server', '.env');
const CONFIG_LOCAL_PATH = path.join(__dirname, 'config.yaml');
const PRESETS_PATH = path.join(__dirname, 'presets.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- .env parser/serializer ----
function parseEnv(text) {
  const config = {};
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    config[key] = value;
  }
  return config;
}

function serializeEnv(config, originalText) {
  // Preserve comments and ordering from original .env, just update values
  const lines = originalText.split('\n');
  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      result.push(line);
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in config) {
      result.push(`${key}=${config[key]}`);
    } else {
      result.push(line);
    }
  }
  // Append any new keys that weren't in the original
  const knownKeys = new Set(
    lines
      .filter(l => l.trim() && !l.trim().startsWith('#'))
      .map(l => l.slice(0, l.indexOf('=')).trim())
      .filter(Boolean)
  );
  for (const [key, value] of Object.entries(config)) {
    if (!knownKeys.has(key)) {
      result.push(`${key}=${value}`);
    }
  }
  return result.join('\n');
}

// ---- API: Presets ----
// Presets store per-backend settings so you can switch without retyping.
// Each preset is a subset of env keys relevant to that backend.

function loadPresets() {
  try {
    if (fs.existsSync(PRESETS_PATH)) {
      return JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[config-editor] Failed to load presets:', e.message);
  }
  return { openclaw: null, hermes: null };
}

function savePresets(presets) {
  try {
    fs.writeFileSync(PRESETS_PATH, JSON.stringify(presets, null, 2), 'utf8');
    console.log('[config-editor] Presets saved to', PRESETS_PATH);
  } catch (e) {
    console.error('[config-editor] Failed to save presets:', e.message);
  }
}

// Backend-specific keys that get stored per-preset
const BACKEND_KEYS = {
  openclaw: ['OPENCLAW_HOST', 'OPENCLAW_PORT', 'OPENCLAW_MODEL', 'OPENCLAW_AGENT_ID', 'OPENCLAW_API_KEY'],
  hermes: ['HERMES_HOST', 'HERMES_PORT', 'HERMES_MODEL', 'HERMES_AGENT_ID', 'HERMES_API_KEY'],
};

app.get('/api/presets', (req, res) => {
  res.json(loadPresets());
});

app.post('/api/presets', (req, res) => {
  const { backend, config } = req.body;
  if (!backend || !BACKEND_KEYS[backend]) {
    return res.status(400).json({ error: 'Invalid backend (must be openclaw or hermes)' });
  }
  const presets = loadPresets();
  // Extract only the backend-specific keys from the full config
  const snapshot = {};
  for (const key of BACKEND_KEYS[backend]) {
    if (config[key] !== undefined) {
      snapshot[key] = config[key];
    }
  }
  presets[backend] = snapshot;
  savePresets(presets);
  res.json({ ok: true, preset: snapshot });
});

app.delete('/api/presets/:backend', (req, res) => {
  const { backend } = req.params;
  if (!BACKEND_KEYS[backend]) {
    return res.status(400).json({ error: 'Invalid backend' });
  }
  const presets = loadPresets();
  delete presets[backend];
  savePresets(presets);
  res.json({ ok: true });
});

// ---- API: Load config from .env ----
app.get('/api/config', (req, res) => {
  try {
    if (!fs.existsSync(ENV_PATH)) {
      return res.status(404).json({ error: `.env not found at ${ENV_PATH}` });
    }
    const text = fs.readFileSync(ENV_PATH, 'utf8');
    const config = parseEnv(text);
    res.json({ config, ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- API: Save config to .env ----
app.post('/api/config_set', async (req, res) => {
  try {
    const config = req.body.config || {};
    // Read original .env to preserve comments/ordering
    let originalText = '';
    if (fs.existsSync(ENV_PATH)) {
      originalText = fs.readFileSync(ENV_PATH, 'utf8');
    }
    const newText = serializeEnv(config, originalText);
    fs.writeFileSync(ENV_PATH, newText, 'utf8');
    console.log('[config-editor] Saved .env at', ENV_PATH);
    res.json({ ok: true, message: 'Saved to .env. Restart ai-server to apply.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- API: Save local backup ----
app.post('/api/config_local', (req, res) => {
  try {
    saveLocalConfig(req.body.config);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config_local', (req, res) => {
  try {
    if (fs.existsSync(CONFIG_LOCAL_PATH)) {
      const yaml = fs.readFileSync(CONFIG_LOCAL_PATH, 'utf8');
      res.json({ yaml, ok: true });
    } else {
      res.json({ yaml: null, ok: false });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- API: Restart ai-server ----
app.post('/api/restart', async (req, res) => {
  try {
    // Kill existing ai-server on port 8765
    const { execSync } = require('child_process');
    try {
      const pid = execSync(`lsof -tiTCP:8765 -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
      if (pid) {
        process.kill(parseInt(pid), 'SIGTERM');
        console.log('[config-editor] Killed ai-server PID', pid);
        // Wait a moment
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      // No process to kill, fine
    }
    // Start fresh
    const { spawn } = require('child_process');
    const envDir = path.resolve(__dirname, '..', 'ai-server');
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: envDir,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log('[config-editor] Started ai-server PID', child.pid);
    // Wait for it to come up
    await new Promise(r => setTimeout(r, 3000));
    // Verify
    try {
      const check = execSync(`lsof -tiTCP:8765 -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
      if (check) {
        res.json({ ok: true, message: 'ai-server restarted', pid: check });
      } else {
        res.json({ ok: false, message: 'ai-server start attempted but port not listening yet' });
      }
    } catch {
      res.json({ ok: false, message: 'ai-server start attempted but port not listening yet' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Live Controls: Volume & Tone ----
// These proxy to the ai-server control API (port 8766) which talks to the robot.
const CONTROL_PORT = process.env.STACKCHAN_CONTROL_PORT || 8766;
const CONTROL_HOST = process.env.STACKCHAN_CONTROL_HOST || '127.0.0.1';

function callControlTool(name, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name, args });
    const options = {
      hostname: CONTROL_HOST,
      port: CONTROL_PORT,
      path: '/tools/call',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    };
    const req = http.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', c => data += c);
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid response from control server')); }
      });
    });
    req.on('error', e => reject(new Error('Cannot reach ai-server control (' + CONTROL_HOST + ':' + CONTROL_PORT + '): ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('ai-server control timed out')); });
    req.write(body);
    req.end();
  });
}

app.post('/api/volume', async (req, res) => {
  const volume = Number(req.body.volume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
    return res.status(400).json({ error: 'volume must be 0-100' });
  }
  try {
    const result = await callControlTool('stackchan_set_speaker_volume', { volume: Math.round(volume), permanent: true });
    if (result && result.success === false) {
      return res.status(502).json({ error: result.error || 'Robot rejected volume change' });
    }
    // Also update BOOT_VOLUME in .env so it persists across reconnects
    if (fs.existsSync(ENV_PATH)) {
      const text = fs.readFileSync(ENV_PATH, 'utf8');
      const config = parseEnv(text);
      config['STACKCHAN_BOOT_VOLUME'] = String(Math.round(volume));
      fs.writeFileSync(ENV_PATH, serializeEnv(config, text), 'utf8');
    }
    res.json({ ok: true, result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/tone', async (req, res) => {
  try {
    const result = await callControlTool('stackchan_play_test_tone', { frequency_hz: 440, duration_ms: 500, amplitude: 6000 });
    if (result && result.success === false) {
      return res.status(502).json({ error: result.error || 'Robot rejected tone' });
    }
    res.json({ ok: true, result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

function saveLocalConfig(config) {
  const yaml = jsonToYaml(config);
  try {
    fs.writeFileSync(CONFIG_LOCAL_PATH, yaml, 'utf8');
    console.log('[config-editor] Saved locally to', CONFIG_LOCAL_PATH);
  } catch (e) {
    console.error('[config-editor] Failed to save locally:', e.message);
  }
}

// Simple JSON → YAML converter (no dependency)
function jsonToYaml(obj, indent = 0) {
  let yaml = '';
  const pad = '  '.repeat(indent);
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined || val === '') {
      yaml += `${pad}${key}:\n`;
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      yaml += `${pad}${key}:\n`;
      yaml += jsonToYaml(val, indent + 1);
    } else if (typeof val === 'boolean') {
      yaml += `${pad}${key}: ${val}\n`;
    } else if (typeof val === 'number') {
      yaml += `${pad}${key}: ${val}\n`;
    } else {
      yaml += `${pad}${key}: "${val}"\n`;
    }
  }
  return yaml;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[config-editor] Running on http://0.0.0.0:${PORT}`);
  console.log(`[config-editor] Config source: ${ENV_PATH}`);
  if (robotIp) {
    console.log(`[config-editor] Robot IP: ${robotIp}`);
  }
});