import { LocalRmsVad, readEnvFloat, type LocalRmsVadConfig, type VadEngine } from './local_vad.js'
import { SileroVad } from './silero_vad.js'

export type VadEngineSelection = 'rms' | 'silero'

export function readVadEngineSelection(env: Record<string, string | undefined> = process.env): VadEngineSelection {
    const raw = (env.STACKCHAN_VAD_ENGINE ?? 'rms').trim().toLowerCase()
    return raw === 'silero' || raw === 'onnx' ? 'silero' : 'rms'
}

// Factory: picks the VAD engine from STACKCHAN_VAD_ENGINE.
// - rms (default): pure energy gate, zero deps.
// - silero: ONNX speech-probability model; ignores STACKCHAN_VAD_RMS_THRESHOLD
//   and uses STACKCHAN_SILERO_THRESHOLD (default 0.5) instead. All other
//   timing knobs (start/end/min speech ms) are shared with the RMS engine.
export function createVad(config: LocalRmsVadConfig): VadEngine {
    if (readVadEngineSelection() === 'silero') {
        const threshold = readEnvFloat('STACKCHAN_SILERO_THRESHOLD', 0.5, 0.05, 0.95)
        return new SileroVad({ ...config, rmsThreshold: threshold })
    }
    return new LocalRmsVad(config)
}
