#!/usr/bin/env node
/**
 * fake_device.mjs — 无硬件端到端验证用的模拟 StackChan 设备
 *
 * 模拟固件行为：连 WS（带 Device-Id 头）→ 发 hello → 打印收到的所有 JSON 消息、
 * 统计下行 Opus 二进制帧。配合 POST /internal/say 验证播报闭环。
 *
 * 用法: node scripts/fake_device.mjs [wsUrl]
 *   默认 ws://127.0.0.1:8765/ws
 */
import WebSocket from 'ws'

const url = process.argv[2] ?? 'ws://127.0.0.1:8765/ws'
const ws = new WebSocket(url, { headers: { 'Device-Id': 'FAKE-DEVICE-001' } })

let binaryFrames = 0
let jsonCount = 0

ws.on('open', () => {
    console.log(`[fake-device] connected to ${url}`)
    ws.send(JSON.stringify({ type: 'hello', version: 3 }))
})

ws.on('message', (data, isBinary) => {
    if (isBinary) {
        binaryFrames += 1
        if (binaryFrames % 25 === 1) console.log(`[fake-device] opus frame #${binaryFrames} (${data.length} bytes)`)
        return
    }
    jsonCount += 1
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (msg.type === 'tts' && msg.state === 'sentence_start') {
        console.log(`[fake-device] ▶ TTS sentence: "${msg.text}"`)
    } else if (msg.type === 'llm') {
        console.log(`[fake-device] 😊 emotion: ${msg.emotion}`)
    } else if (msg.type === 'tts' && (msg.state === 'stop' || msg.state === 'start')) {
        console.log(`[fake-device] tts ${msg.state}`)
    } else {
        console.log(`[fake-device] json: ${data.toString().slice(0, 200)}`)
    }
})

ws.on('close', () => { console.log(`[fake-device] closed. total opus frames=${binaryFrames} json msgs=${jsonCount}`); process.exit(0) })
ws.on('error', (err) => { console.error('[fake-device] error:', err.message); process.exit(1) })

// 60s 后自动退出并汇报
setTimeout(() => {
    console.log(`\n[fake-device] timeout exit. total opus frames=${binaryFrames} json msgs=${jsonCount}`)
    process.exit(binaryFrames > 0 ? 0 : 2)
}, 60000)
