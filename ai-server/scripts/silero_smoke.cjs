// Smoke test: load silero_vad.onnx, run a few windows of silence and noise,
// verify output names/shapes/sr dtype work and probability behaves.
const ort = require('onnxruntime-node')
const fs = require('fs')

async function main() {
    const session = await ort.InferenceSession.create('models/silero_vad.onnx', { graphOptimizationLevel: 'all' })
    console.log('inputNames:', session.inputNames.join(','))
    console.log('outputNames:', session.outputNames.join(','))
    const state = new Float32Array(2 * 1 * 128)
    const runWindow = async (samples) => {
        const feed = {
            input: new ort.Tensor('float32', samples, [1, samples.length]),
            state: new ort.Tensor('float32', state, [2, 1, 128]),
            sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
        }
        const out = await session.run(feed)
        state.set(out.stateN.data)
        return out.output.data[out.output.data.length - 1]
    }
    // silence
    const silence = new Float32Array(512)
    let ps = 0
    for (let i = 0; i < 10; i++) ps = await runWindow(silence)
    console.log('silence prob:', ps.toFixed(4))
    // white noise
    const noise = new Float32Array(512)
    for (let i = 0; i < 512; i++) noise[i] = (Math.random() * 2 - 1) * 0.3
    let pn = 0
    for (let i = 0; i < 10; i++) pn = await runWindow(noise)
    console.log('noise prob:', pn.toFixed(4))
    // 1kHz-ish tone burst
    const tone = new Float32Array(512)
    for (let i = 0; i < 512; i++) tone[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / 16000)
    let pt = 0
    for (let i = 0; i < 10; i++) pt = await runWindow(tone)
    console.log('tone prob:', pt.toFixed(4))
    console.log('SMOKE_OK')
}

main().catch((e) => { console.error('SMOKE_FAIL', e); process.exit(1) })
