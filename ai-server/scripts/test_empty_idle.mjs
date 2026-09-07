#!/usr/bin/env node
/**
 * test_empty_idle.mjs — 验证空转修复：
 * 模拟设备连接 → 触发进入 listening(auto) → 保持静默(不发人声/不触发处理)
 * 期望: 服务器在 EMPTY_LISTEN_LIMIT × MAX_RECORDING_MS(默认2×15s=30s) 无有效语音后
 *       自动回 idle (日志出现 "returning to idle")，而不是无限 empty-timeout 重听。
 *
 * 用法: node scripts/test_empty_idle.mjs [观察时长ms 默认 40000]
 */
import WebSocket from 'ws'

const url = 'ws://127.0.0.1:8765/ws'
const OBSERVE_MS = Number(process.argv[2] ?? 40000)

const ws = new WebSocket(url, { headers: { 'Device-Id': 'EMPTY-IDLE-TEST' } })
let jsonCount = 0

const t0 = Date.now()
function elapsed() { return ((Date.now() - t0) / 1000).toFixed(1) }

ws.on('open', () => {
    console.log(`[t+${elapsed()}] connected, sending hello`)
    ws.send(JSON.stringify({ type: 'hello', version: 3 }))
    // 稍后触发服务器进入 listening(auto)
    setTimeout(() => {
        console.log(`[t+${elapsed()}] send listen mode=auto (模拟设备进入监听, 之后保持静默不说话)`)
        ws.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }))
    }, 500)
})

ws.on('message', (data, isBinary) => {
    if (isBinary) return // 忽略下行音频
    jsonCount += 1
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    const type = msg.type ?? '?'
    const state = msg.state ?? ''
    // 只打印关键下行
    if (['hello', 'listen', 'stt', 'llm', 'abort', 'tts'].includes(type)) {
        console.log(`[t+${elapsed()}] ⇩ ${type}${state ? `:${state}` : ''}` +
            (msg.text ? ` text="${msg.text}"` : '') + (msg.emotion ? ` emotion=${msg.emotion}` : ''))
    }
})

ws.on('close', (code) => console.log(`[t+${elapsed()}] closed code=${code}`))
ws.on('error', (e) => console.log(`[t+${elapsed()}] error: ${e.message}`))

// 观察结束后关闭
setTimeout(() => {
    console.log(`[t+${elapsed()}] observe window done (${OBSERVE_MS}ms). 请到 ai-server 后台任务日志查看是否出现 "returning to idle"。`)
    try { ws.close() } catch { /* noop */ }
    process.exit(0)
}, OBSERVE_MS)
