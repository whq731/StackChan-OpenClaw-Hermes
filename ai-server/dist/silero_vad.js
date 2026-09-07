"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SileroVad = void 0;
exports.sileroVadModelPath = sileroVadModelPath;
const path_1 = __importDefault(require("path"));
const local_vad_js_1 = require("./local_vad.js");
// Silero VAD v5 processes 512-sample windows at 16 kHz (32 ms per window).
const SILERO_WINDOW_SAMPLES = 512;
const SILERO_WINDOW_BYTES = SILERO_WINDOW_SAMPLES * 2;
const SILERO_FRAME_MS = (SILERO_WINDOW_SAMPLES * 1000) / local_vad_js_1.LOCAL_VAD_SAMPLE_RATE;
// Used only when the ONNX model cannot be loaded/inferred: degrade to an
// energy gate so the voice loop keeps working instead of going deaf.
const FALLBACK_RMS_THRESHOLD = 0.012;
const MAX_QUEUED_WINDOWS = 200;
function sileroVadModelPath() {
    // Resolve relative to this module (src/ in dev, dist/ in production) so
    // the model is found regardless of the process working directory.
    if (process.env.STACKCHAN_SILERO_MODEL_PATH)
        return process.env.STACKCHAN_SILERO_MODEL_PATH;
    return path_1.default.resolve(__dirname, '..', 'models', 'silero_vad.onnx');
}
class SileroVad {
    config;
    ort = null;
    session = null;
    // v4 models expose separate h/c inputs; v5 uses a single `state` tensor.
    usesLegacyState = false;
    initFailed = false;
    initStarted = false;
    // Incremented by reset() so in-flight async window results are discarded.
    generation = 0;
    chain = Promise.resolve();
    queued = 0;
    windowBuf = Buffer.alloc(0);
    state = new Float32Array(2 * 1 * 128);
    hState = new Float32Array(2 * 1 * 64);
    cState = new Float32Array(2 * 1 * 64);
    // Same state machine fields as LocalRmsVad, but advanced asynchronously
    // as window inferences complete; events are drained by the next sync
    // processPcm() call.
    speechRunMs = 0;
    activeSpeechMs = 0;
    silenceRunMs = 0;
    started = false;
    lastRms = 0;
    lastProb = 0;
    evSpeechStarted = false;
    evUtteranceEnded = false;
    evIgnoredShort = false;
    // Snapshot of speech/silence durations captured when an end event fires:
    // advance() zeroes the live counters immediately, but the event is drained
    // by a later synchronous processPcm() call, which must still report the
    // real durations (session.ts gates on speechMs >= minSpeechMs).
    evSpeechMs = 0;
    evSilenceMs = 0;
    constructor(config) {
        this.config = config;
    }
    reset() {
        this.generation += 1;
        this.chain = Promise.resolve();
        this.queued = 0;
        this.windowBuf = Buffer.alloc(0);
        this.state.fill(0);
        this.hState.fill(0);
        this.cState.fill(0);
        this.speechRunMs = 0;
        this.activeSpeechMs = 0;
        this.silenceRunMs = 0;
        this.started = false;
        this.evSpeechStarted = false;
        this.evUtteranceEnded = false;
        this.evIgnoredShort = false;
        this.evSpeechMs = 0;
        this.evSilenceMs = 0;
    }
    processPcm(pcm) {
        const neutral = () => ({
            speechStarted: false,
            inSpeech: this.started,
            utteranceEnded: false,
            ignoredShortSpeech: false,
            speechMs: this.activeSpeechMs,
            silenceMs: this.silenceRunMs,
            rms: this.lastRms,
        });
        if (!this.config.enabled || pcm.length === 0)
            return neutral();
        this.kickInit();
        let data = this.windowBuf.length > 0 ? Buffer.concat([this.windowBuf, pcm]) : pcm;
        while (data.length >= SILERO_WINDOW_BYTES) {
            const windowPcm = data.subarray(0, SILERO_WINDOW_BYTES);
            data = data.subarray(SILERO_WINDOW_BYTES);
            this.enqueueWindow(windowPcm);
        }
        this.windowBuf = Buffer.from(data);
        const reportEndEvent = this.evUtteranceEnded || this.evIgnoredShort;
        const result = {
            speechStarted: this.evSpeechStarted,
            inSpeech: this.started,
            utteranceEnded: this.evUtteranceEnded,
            ignoredShortSpeech: this.evIgnoredShort,
            speechMs: reportEndEvent ? this.evSpeechMs : this.activeSpeechMs,
            silenceMs: reportEndEvent ? this.evSilenceMs : this.silenceRunMs,
            rms: this.lastRms,
        };
        this.evSpeechStarted = false;
        this.evUtteranceEnded = false;
        this.evIgnoredShort = false;
        return result;
    }
    kickInit() {
        if (this.initStarted)
            return;
        this.initStarted = true;
        void this.ensureSession();
    }
    async ensureSession() {
        if (this.session || this.initFailed)
            return;
        try {
            const ort = await Promise.resolve().then(() => __importStar(require('onnxruntime-node')));
            const modelPath = sileroVadModelPath();
            const session = await ort.InferenceSession.create(modelPath, { graphOptimizationLevel: 'all' });
            this.ort = ort;
            this.session = session;
            const inputNames = new Set(session.inputNames);
            this.usesLegacyState = inputNames.has('h') && inputNames.has('c');
            console.log(`[silero-vad] model loaded path=${modelPath} inputs=${[...inputNames].join(',')}`);
        }
        catch (error) {
            this.initFailed = true;
            console.warn(`[silero-vad] failed to load model (${sileroVadModelPath()}), falling back to RMS energy gate: ${String(error)}`);
        }
    }
    enqueueWindow(windowPcm) {
        // Backpressure: drop windows rather than grow unbounded if inference
        // ever falls behind realtime.
        if (this.queued >= MAX_QUEUED_WINDOWS)
            return;
        this.queued += 1;
        const samples = new Float32Array(SILERO_WINDOW_SAMPLES);
        for (let i = 0; i < SILERO_WINDOW_SAMPLES; i++) {
            samples[i] = windowPcm.readInt16LE(i * 2) / 32768;
        }
        const rms = (0, local_vad_js_1.rmsNormalized)(windowPcm);
        const gen = this.generation;
        this.chain = this.chain
            .then(async () => {
            if (gen !== this.generation)
                return;
            await this.ensureSession();
            let voiced;
            if (this.session && this.ort && !this.initFailed) {
                try {
                    const prob = await this.runWindow(samples);
                    if (gen !== this.generation)
                        return;
                    this.lastProb = prob;
                    voiced = prob >= this.config.rmsThreshold;
                    if (process.env.STACKCHAN_SILERO_DEBUG)
                        console.log(`[silero-vad][debug] prob=${prob.toFixed(4)} rms=${rms.toFixed(4)} voiced=${voiced}`);
                }
                catch (error) {
                    this.initFailed = true;
                    console.warn(`[silero-vad] inference failed, falling back to RMS energy gate: ${String(error)}`);
                    voiced = rms >= FALLBACK_RMS_THRESHOLD;
                }
            }
            else {
                voiced = rms >= FALLBACK_RMS_THRESHOLD;
            }
            this.lastRms = rms;
            this.advance(voiced);
        })
            .catch(() => { })
            .finally(() => {
            this.queued = Math.max(0, this.queued - 1);
        });
    }
    // Same state machine as LocalRmsVad, but with a fixed 32 ms frame.
    advance(voiced) {
        if (!this.started) {
            if (voiced) {
                this.speechRunMs += SILERO_FRAME_MS;
                if (this.speechRunMs >= this.config.startSpeechMs) {
                    this.started = true;
                    this.evSpeechStarted = true;
                    this.activeSpeechMs = this.speechRunMs;
                    this.silenceRunMs = 0;
                }
            }
            else {
                this.speechRunMs = 0;
            }
            return;
        }
        if (voiced) {
            this.activeSpeechMs += SILERO_FRAME_MS;
            this.silenceRunMs = 0;
            return;
        }
        this.silenceRunMs += SILERO_FRAME_MS;
        if (this.silenceRunMs >= this.config.endSilenceMs) {
            this.evSpeechMs = this.activeSpeechMs;
            this.evSilenceMs = this.silenceRunMs;
            if (this.activeSpeechMs >= this.config.minSpeechMs) {
                this.evUtteranceEnded = true;
            }
            else {
                this.evIgnoredShort = true;
            }
            this.speechRunMs = 0;
            this.activeSpeechMs = 0;
            this.silenceRunMs = 0;
            this.started = false;
        }
    }
    async runWindow(samples) {
        const ort = this.ort;
        const session = this.session;
        if (!ort || !session)
            throw new Error('silero session not ready');
        const feed = {
            input: new ort.Tensor('float32', samples, [1, samples.length]),
            sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(local_vad_js_1.LOCAL_VAD_SAMPLE_RATE)]), []),
        };
        if (this.usesLegacyState) {
            feed.h = new ort.Tensor('float32', this.hState, [2, 1, 64]);
            feed.c = new ort.Tensor('float32', this.cState, [2, 1, 64]);
        }
        else {
            feed.state = new ort.Tensor('float32', this.state, [2, 1, 128]);
        }
        const out = await session.run(feed);
        const stateOut = (out.stateN ?? out.state);
        if (stateOut)
            this.state.set(stateOut.data);
        const hOut = out.hN;
        if (hOut)
            this.hState.set(hOut.data);
        const cOut = out.cN;
        if (cOut)
            this.cState.set(cOut.data);
        const output = out.output;
        const data = output.data;
        return Number(data[data.length - 1]);
    }
    /** Latest speech probability (for logging/diagnostics). */
    get probability() {
        return this.lastProb;
    }
}
exports.SileroVad = SileroVad;
