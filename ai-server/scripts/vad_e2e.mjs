// vad_e2e.mjs — 端到端验证 SileroVAD：噪声不触发，人声触发
import WebSocket from 'ws'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
const require = createRequire('~/projects/StackChan-OpenClaw-Hermes/ai-server/package.json')
const OpusScript = require('opusscript')

const WS_URL = 'ws://127.0.0.1:8765/ws'
const SR = 16000
const FRAME_SAMPLES = 960 // 60ms

const encoder = new OpusScript(SR, 1, OpusScript.Application.VOIP)

function wrap(opus) {
    const header = Buffer.alloc(4)
    header[0] = 0x00; header[1] = 0x00
    header.writeUInt16BE(opus.length, 2)
    return Buffer.concat([header, opus])
}

function pcmToFrames(pcm) {
    const frames = []
    for (let off = 0; off + FRAME_SAMPLES * 2 <= pcm.length; off += FRAME_SAMPLES * 2) {
        const chunk = pcm.subarray(off, off + FRAME_SAMPLES * 2)
        frames.push(wrap(encoder.encode(chunk, FRAME_SAMPLES)))
    }
    return frames
}

function silencePcm(ms, amp = 3) {
    return Buffer.alloc(Math.floor((ms / 1000) * SR) * 2).map(
        () => Math.round((Math.random() * 2 - 1) * amp)
    )
}

function noisePcm(ms, amp = 400) { // 电视/音乐模拟：有能量但非人声
    const n = Math.floor((ms / 1000) * SR)
    const buf = Buffer.alloc(n * 2)
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((Math.random() * 2 - 1) * amp), i * 2)
    return buf
}

function speechPcm() {
    const wav = readFileSync('/tmp/speech_16k.wav')
    let off = 12
    while (off < wav.length - 8) {
        const id = wav.toString('ascii', off, off + 4)
        const size = wav.readUInt32LE(off + 4)
        if (id === 'data') { 
            const end = Math.min(off + 8 + size, off + 8 + Math.floor(4.5 * SR) * 2)
            return wav.subarray(off + 8, end)
        }
        off += 8 + size + (size % 2)
    }
    throw new Error('no data chunk')
}

async function sendPaced(ws, frames, msPerFrame) {
    for (const f of frames) {
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(f)
        await new Promise(r => setTimeout(r, msPerFrame))
    }
}

const ws = new WebSocket(WS_URL, { headers: { 'Device-Id': 'VAD-E2E-TEST' } })
ws.on('message', (data, isBinary) => {
    if (!isBinary) {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'hello') console.log('[client] server hello ok, version=', msg.version)
    }
})
ws.on('error', e => { console.error('[client] error:', e.message); process.exit(1) })

ws.on('open', async () => {
    console.log('[client] connected')
    ws.send(JSON.stringify({ type: 'hello', version: 3 }))
    await new Promise(r => setTimeout(r, 800))

    ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'manual' }))
    console.log('[client] listen start')
    await new Promise(r => setTimeout(r, 300))

    console.log('[client] >>> phase 1: 2s noise (should NOT trigger VAD)')
    await sendPaced(ws, pcmToFrames(noisePcm(2000)), 60)

    console.log('[client] >>> phase 2: 4.5s speech (should trigger VAD)')
    await sendPaced(ws, pcmToFrames(speechPcm()), 60)

    console.log('[client] >>> phase 3: 2s trailing silence (utterance end)')
    await sendPaced(ws, pcmToFrames(silencePcm(2000)), 60)

    console.log('[client] done streaming, waiting 5s for server processing')
    await new Promise(r => setTimeout(r, 5000))
    ws.close()
    process.exit(0)
})
