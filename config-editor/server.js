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

const CONFIG_LOCAL_PATH = path.join(__dirname, 'config.yaml');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Proxy: GET /config from robot
app.get('/api/config', (req, res) => {
  const ip = req.query.robotIp || robotIp || '';
  if (!ip) return res.status(400).json({ error: 'No robot IP specified' });
  
  const options = {
    hostname: ip,
    port: 80,
    path: '/config',
    method: 'GET',
    timeout: 5000,
  };
  
  const proxyReq = http.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      try {
        const json = JSON.parse(body);
        res.json(json);
      } catch {
        res.status(502).json({ error: 'Invalid response from robot', raw: body.substring(0, 500) });
      }
    });
  });
  
  proxyReq.on('error', (e) => {
    res.status(502).json({ error: `Cannot reach robot at ${ip}: ${e.message}` });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.status(504).json({ error: `Robot at ${ip} timed out` });
  });
  
  proxyReq.end();
});

// Proxy: POST /config_set to robot
app.post('/api/config_set', (req, res) => {
  const ip = req.body.robotIp || robotIp || '';
  if (!ip) return res.status(400).json({ error: 'No robot IP specified' });
  
  const configData = JSON.stringify(req.body.config);
  
  const options = {
    hostname: ip,
    port: 80,
    path: '/config_set',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(configData),
    },
    timeout: 10000,
  };
  
  const proxyReq = http.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      // Also save locally
      saveLocalConfig(req.body.config);
      res.status(proxyRes.statusCode).json({ ok: true, robotResponse: body });
    });
  });
  
  proxyReq.on('error', (e) => {
    // Save locally even if robot is unreachable
    saveLocalConfig(req.body.config);
    res.status(502).json({ error: `Cannot reach robot at ${ip}: ${e.message}`, localSaved: true });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    saveLocalConfig(req.body.config);
    res.status(504).json({ error: `Robot at ${ip} timed out`, localSaved: true });
  });
  
  proxyReq.write(configData);
  proxyReq.end();
});

// Save locally
app.post('/api/config_local', (req, res) => {
  saveLocalConfig(req.body.config);
  res.json({ ok: true });
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

// Load locally
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
  if (robotIp) {
    console.log(`[config-editor] Robot IP: ${robotIp}`);
  } else {
    console.log('[config-editor] No robot IP set — enter it in the UI');
  }
});