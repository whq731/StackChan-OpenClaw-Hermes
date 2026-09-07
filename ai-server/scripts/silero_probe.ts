// Integration probe: feed a real speech wav through SileroVad in 30 ms
// frames (like the session loop does) and check speech events fire.
import { readFileSync } from 'fs'
import { SileroVad } from '../src/silero_vad.ts'
import { LocalRmsVad } from '../src/local_vad.ts'

function pcmFromWav(buf: Buffer): Buffer {
    // naive RIFF walker: find 'data' chunk
    let off = 12
    while (off < buf.length - 8) {
        const id = buf.toString('ascii', off, off + 4)
        const size = buf.readUInt32LE(off + 4)
        if (id === 'data') return buf.subarray(off + 8, off + 8 + size)
        off += 8 + size + (size % 2)
    }
    throw new Error('no data chunk')
}

const pcm = pcmFromWav(readFileSync('/tmp/speech_16k.wav'))
console.log('pcm bytes:', pcm.length, '≈', Math.round(pcm.length / 32), 'ms')

function frameMs(): number { return 30 }
const FRAME = 480 * 2 // 30 ms of 16k mono s16le

async function run(label: string, vad: { processPcm(p: Buffer): any; reset(): void; probability?: number }) {
    vad.reset()
    let started = -1, ended = -1, peak = 0
    const t0 = Date.now()
    // Pace frames at ~8 ms each — close enough to realtime (30 ms) that the
    // async inference pipeline keeps up, as it does in the session loop.
    for (let off = 0; off + FRAME <= pcm.length; off += FRAME) {
        const r = vad.processPcm(pcm.subarray(off, off + FRAME))
        if (typeof vad.probability === 'number' && vad.probability > peak) peak = vad.probability
        if (r.speechStarted && started < 0) started = Math.round(off / 32)
        if (r.utteranceEnded && ended < 0) ended = Math.round(off / 32)
        await new Promise((res) => setTimeout(res, 8))
    }
    // Settle: let queued async inferences finish, then drain events with silence.
    await new Promise((r) => setTimeout(r, 300))
    let drainedEnd = false
    for (let i = 0; i < 80; i++) { // 2.4 s silence
        const r = vad.processPcm(Buffer.alloc(FRAME))
        if (r.utteranceEnded) drainedEnd = true
        await new Promise((res) => setTimeout(res, 8))
    }
    const prob = typeof vad.probability === 'number' ? peak.toFixed(3) : 'n/a'
    console.log(`${label}: started@${started}ms ended@${ended}ms drainedEnd=${drainedEnd} peakProb=${prob} total=${Date.now() - t0}ms`)
}

// env is loaded by caller; force silero config here
const cfg = {
    enabled: true,
    rmsThreshold: Number(process.env.STACKCHAN_SILERO_THRESHOLD ?? 0.5),
    startSpeechMs: 120,
    endSilenceMs: Number(process.env.STACKCHAN_VAD_END_SILENCE_MS ?? 600),
    minSpeechMs: 240,
    preRollMs: 300,
}
async function main() {
    await run('silero', new SileroVad(cfg))
    await run('rms(0.012)', new LocalRmsVad({ ...cfg, rmsThreshold: 0.012 }))
    console.log('PROBE_DONE')
}
void main()
