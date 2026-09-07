"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readVadEngineSelection = readVadEngineSelection;
exports.createVad = createVad;
const local_vad_js_1 = require("./local_vad.js");
const silero_vad_js_1 = require("./silero_vad.js");
function readVadEngineSelection(env = process.env) {
    const raw = (env.STACKCHAN_VAD_ENGINE ?? 'rms').trim().toLowerCase();
    return raw === 'silero' || raw === 'onnx' ? 'silero' : 'rms';
}
// Factory: picks the VAD engine from STACKCHAN_VAD_ENGINE.
// - rms (default): pure energy gate, zero deps.
// - silero: ONNX speech-probability model; ignores STACKCHAN_VAD_RMS_THRESHOLD
//   and uses STACKCHAN_SILERO_THRESHOLD (default 0.5) instead. All other
//   timing knobs (start/end/min speech ms) are shared with the RMS engine.
function createVad(config) {
    if (readVadEngineSelection() === 'silero') {
        const threshold = (0, local_vad_js_1.readEnvFloat)('STACKCHAN_SILERO_THRESHOLD', 0.5, 0.05, 0.95);
        return new silero_vad_js_1.SileroVad({ ...config, rmsThreshold: threshold });
    }
    return new local_vad_js_1.LocalRmsVad(config);
}
