import path from 'path'
import type { InferenceSession } from 'onnxruntime-node'
import {
    LOCAL_VAD_SAMPLE_RATE,
    readEnvFloat,
    rmsNormalized,
    type LocalRmsVadConfig,
    type LocalRmsVadResult,
    type VadEngine,
} from './local_vad.js'

// Silero VAD v5 processes 512-sample windows at 16 kHz (32 ms per window).
const SILERO_WINDOW_SAMPLES = 512
const SILERO_WINDOW_BYTES = SILERO_WINDOW_SAMPLES * 2
const SILERO_FRAME_MS = (SILERO_WINDOW_SAMPLES * 1000) / LOCAL_VAD_SAMPLE_RATE

// Used only when the ONNX model cannot be loaded/inferred: degrade to an
// energy gate so the voice loop keeps working instead of going deaf.
const FALLBACK_RMS_THRESHOLD = 0.012
const MAX_QUEUED_WINDOWS = 200

export function sileroVadModelPath(): string {
    // Resolve relative to this module (src/ in dev, dist/ in production) so
    // the model is found regardless of the process working directory.
    if (process.env.STACKCHAN_SILERO_MODEL_PATH) return process.env.STACKCHAN_SILERO_MODEL_PATH
    return path.resolve(__dirname, '..', 'models', 'silero_vad.onnx')
}

type OrtModule = typeof import('onnxruntime-node')

export class SileroVad implements VadEngine {
    private ort: OrtModule | null = null
    private session: InferenceSession | null = null
    // v4 models expose separate h/c inputs; v5 uses a single `state` tensor.
    private usesLegacyState = false
    private initFailed = false
    private initStarted = false
    // Incremented by reset() so in-flight async window results are discarded.
    private generation = 0
    private chain: Promise<void> = Promise.resolve()
    private queued = 0

    private windowBuf = Buffer.alloc(0)
    private state = new Float32Array(2 * 1 * 128)
    private hState = new Float32Array(2 * 1 * 64)
    private cState = new Float32Array(2 * 1 * 64)

    // Same state machine fields as LocalRmsVad, but advanced asynchronously
    // as window inferences complete; events are drained by the next sync
    // processPcm() call.
    private speechRunMs = 0
    private activeSpeechMs = 0
    private silenceRunMs = 0
    private started = false
    private lastRms = 0
    private lastProb = 0
    private evSpeechStarted = false
    private evUtteranceEnded = false
    private evIgnoredShort = false
    // Snapshot of speech/silence durations captured when an end event fires:
    // advance() zeroes the live counters immediately, but the event is drained
    // by a later synchronous processPcm() call, which must still report the
    // real durations (session.ts gates on speechMs >= minSpeechMs).
    private evSpeechMs = 0
    private evSilenceMs = 0

    constructor(private readonly config: LocalRmsVadConfig) {}

    reset(): void {
        this.generation += 1
        this.chain = Promise.resolve()
        this.queued = 0
        this.windowBuf = Buffer.alloc(0)
        this.state.fill(0)
        this.hState.fill(0)
        this.cState.fill(0)
        this.speechRunMs = 0
        this.activeSpeechMs = 0
        this.silenceRunMs = 0
        this.started = false
        this.evSpeechStarted = false
        this.evUtteranceEnded = false
        this.evIgnoredShort = false
        this.evSpeechMs = 0
        this.evSilenceMs = 0
    }

    processPcm(pcm: Buffer): LocalRmsVadResult {
        const neutral = (): LocalRmsVadResult => ({
            speechStarted: false,
            inSpeech: this.started,
            utteranceEnded: false,
            ignoredShortSpeech: false,
            speechMs: this.activeSpeechMs,
            silenceMs: this.silenceRunMs,
            rms: this.lastRms,
        })
        if (!this.config.enabled || pcm.length === 0) return neutral()

        this.kickInit()
        let data = this.windowBuf.length > 0 ? Buffer.concat([this.windowBuf, pcm]) : pcm
        while (data.length >= SILERO_WINDOW_BYTES) {
            const windowPcm = data.subarray(0, SILERO_WINDOW_BYTES)
            data = data.subarray(SILERO_WINDOW_BYTES)
            this.enqueueWindow(windowPcm)
        }
        this.windowBuf = Buffer.from(data)

        const reportEndEvent = this.evUtteranceEnded || this.evIgnoredShort
        const result: LocalRmsVadResult = {
            speechStarted: this.evSpeechStarted,
            inSpeech: this.started,
            utteranceEnded: this.evUtteranceEnded,
            ignoredShortSpeech: this.evIgnoredShort,
            speechMs: reportEndEvent ? this.evSpeechMs : this.activeSpeechMs,
            silenceMs: reportEndEvent ? this.evSilenceMs : this.silenceRunMs,
            rms: this.lastRms,
        }
        this.evSpeechStarted = false
        this.evUtteranceEnded = false
        this.evIgnoredShort = false
        return result    }

    private kickInit(): void {
        if (this.initStarted) return
        this.initStarted = true
        void this.ensureSession()
    }

    private async ensureSession(): Promise<void> {
        if (this.session || this.initFailed) return
        try {
            const ort = await import('onnxruntime-node')
            const modelPath = sileroVadModelPath()
            const session = await ort.InferenceSession.create(modelPath, { graphOptimizationLevel: 'all' })
            this.ort = ort
            this.session = session
            const inputNames = new Set(session.inputNames)
            this.usesLegacyState = inputNames.has('h') && inputNames.has('c')
            console.log(`[silero-vad] model loaded path=${modelPath} inputs=${[...inputNames].join(',')}`)
        } catch (error) {
            this.initFailed = true
            console.warn(`[silero-vad] failed to load model (${sileroVadModelPath()}), falling back to RMS energy gate: ${String(error)}`)
        }
    }

    private enqueueWindow(windowPcm: Buffer): void {
        // Backpressure: drop windows rather than grow unbounded if inference
        // ever falls behind realtime.
        if (this.queued >= MAX_QUEUED_WINDOWS) return
        this.queued += 1
        const samples = new Float32Array(SILERO_WINDOW_SAMPLES)
        for (let i = 0; i < SILERO_WINDOW_SAMPLES; i++) {
            samples[i] = windowPcm.readInt16LE(i * 2) / 32768
        }
        const rms = rmsNormalized(windowPcm)
        const gen = this.generation
        this.chain = this.chain
            .then(async () => {
                if (gen !== this.generation) return
                await this.ensureSession()
                let voiced: boolean
                if (this.session && this.ort && !this.initFailed) {
                    try {
                        const prob = await this.runWindow(samples)
                        if (gen !== this.generation) return
                        this.lastProb = prob
                        voiced = prob >= this.config.rmsThreshold
                        if (process.env.STACKCHAN_SILERO_DEBUG) console.log(`[silero-vad][debug] prob=${prob.toFixed(4)} rms=${rms.toFixed(4)} voiced=${voiced}`)
                    } catch (error) {
                        this.initFailed = true
                        console.warn(`[silero-vad] inference failed, falling back to RMS energy gate: ${String(error)}`)
                        voiced = rms >= FALLBACK_RMS_THRESHOLD
                    }
                } else {
                    voiced = rms >= FALLBACK_RMS_THRESHOLD
                }
                this.lastRms = rms
                this.advance(voiced)
            })
            .catch(() => {})
            .finally(() => {
                this.queued = Math.max(0, this.queued - 1)
            })
    }

    // Same state machine as LocalRmsVad, but with a fixed 32 ms frame.
    private advance(voiced: boolean): void {
        if (!this.started) {
            if (voiced) {
                this.speechRunMs += SILERO_FRAME_MS
                if (this.speechRunMs >= this.config.startSpeechMs) {
                    this.started = true
                    this.evSpeechStarted = true
                    this.activeSpeechMs = this.speechRunMs
                    this.silenceRunMs = 0
                }
            } else {
                this.speechRunMs = 0
            }
            return
        }
        if (voiced) {
            this.activeSpeechMs += SILERO_FRAME_MS
            this.silenceRunMs = 0
            return
        }
        this.silenceRunMs += SILERO_FRAME_MS
        if (this.silenceRunMs >= this.config.endSilenceMs) {
            this.evSpeechMs = this.activeSpeechMs
            this.evSilenceMs = this.silenceRunMs
            if (this.activeSpeechMs >= this.config.minSpeechMs) {
                this.evUtteranceEnded = true
            } else {
                this.evIgnoredShort = true
            }
            this.speechRunMs = 0
            this.activeSpeechMs = 0
            this.silenceRunMs = 0
            this.started = false
        }
    }

    private async runWindow(samples: Float32Array): Promise<number> {
        const ort = this.ort
        const session = this.session
        if (!ort || !session) throw new Error('silero session not ready')
        const feed: Record<string, InstanceType<OrtModule['Tensor']>> = {
            input: new ort.Tensor('float32', samples, [1, samples.length]),
            sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(LOCAL_VAD_SAMPLE_RATE)]), []),
        }
        if (this.usesLegacyState) {
            feed.h = new ort.Tensor('float32', this.hState, [2, 1, 64])
            feed.c = new ort.Tensor('float32', this.cState, [2, 1, 64])
        } else {
            feed.state = new ort.Tensor('float32', this.state, [2, 1, 128])
        }
        const out = await session.run(feed)
        const stateOut = (out.stateN ?? out.state) as InstanceType<OrtModule['Tensor']> | undefined
        if (stateOut) this.state.set(stateOut.data as Float32Array)
        const hOut = out.hN as InstanceType<OrtModule['Tensor']> | undefined
        if (hOut) this.hState.set(hOut.data as Float32Array)
        const cOut = out.cN as InstanceType<OrtModule['Tensor']> | undefined
        if (cOut) this.cState.set(cOut.data as Float32Array)
        const output = out.output as InstanceType<OrtModule['Tensor']>
        const data = output.data as Float32Array
        return Number(data[data.length - 1])
    }

    /** Latest speech probability (for logging/diagnostics). */
    get probability(): number {
        return this.lastProb
    }
}
