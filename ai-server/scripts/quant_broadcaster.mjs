#!/usr/bin/env node
/**
 * quant_broadcaster.mjs — stock-portfolio-app 事件 → StackChan 语音播报桥
 *
 * 轮询量化系统的 real-quant 订单接口，检测到新订单 / 状态变化时，
 * 把中文播报文本 POST 到 ai-server 控制口的 /internal/say，
 * 由机器人用 TTS 说出并同步切换表情（buy=happy, sell/止损=sad, 待确认=doubtful）。
 *
 * 用法:
 *   node scripts/quant_broadcaster.mjs
 *
 * 环境变量:
 *   QUANT_API_BASE                量化系统地址        (默认 http://127.0.0.1:3001)
 *   STACKCHAN_CONTROL_URL         ai-server 控制口    (默认 http://127.0.0.1:8766)
 *   QUANT_BROADCAST_INTERVAL_MS   轮询间隔            (默认 15000)
 *   QUANT_BROADCAST_STATE_FILE    去重状态文件        (默认 <script>/.quant_broadcaster_state.json)
 *   QUANT_BROADCAST_SEMI_ONLY     只播报 semi 模式订单 (默认 false, auto/semi 都播)
 *
 * 手动测试:
 *   curl -X POST http://127.0.0.1:8766/internal/say \
 *     -H 'content-type: application/json' \
 *     -d '{"text":"测试播报：贵州茅台买入信号","emotion":"happy"}'
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const QUANT_API_BASE = process.env.QUANT_API_BASE ?? 'http://127.0.0.1:3001'
const CONTROL_URL = process.env.STACKCHAN_CONTROL_URL ?? 'http://127.0.0.1:8766'
const INTERVAL_MS = Math.max(3000, parseInt(process.env.QUANT_BROADCAST_INTERVAL_MS ?? '15000', 10) || 15000)
const STATE_FILE = process.env.QUANT_BROADCAST_STATE_FILE ?? join(__dirname, '.quant_broadcaster_state.json')
const SEMI_ONLY = /^(1|true|yes|on)$/i.test(process.env.QUANT_BROADCAST_SEMI_ONLY ?? '')

const ORDER_STATUS_TEXT = {
    pending_confirm: '等待确认',
    confirmed: '已确认下单',
    rejected: '已拒绝',
    sent: '已报送',
    filled: '已成交',
    partial: '部分成交',
    cancelled: '已撤单',
    expired: '已过期',
    error: '委托失败',
}

function loadState() {
    try {
        return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    } catch {
        return { orders: {} } // orderId -> last status
    }
}

function saveState(state) {
    try {
        writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
    } catch (err) {
        console.error('[broadcaster] 保存状态文件失败:', err.message)
    }
}

function fmtPrice(v) {
    const n = Number(v)
    if (!Number.isFinite(n)) return null
    return n.toFixed(2)
}

function fmtShares(v) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.round(n).toString()
}

/** 由订单事件生成 {text, emotion}；不感兴趣返回 null */
function orderToAnnouncement(order, prevStatus) {
    const name = order.name || order.symbol || '未知标的'
    const code = order.symbol ?? ''
    const action = order.action === 'sell' ? '卖出' : '买入'
    const price = fmtPrice(order.price)
    const shares = fmtShares(order.shares)
    const signalName = order.signal_name || order.signal_type || ''

    // 新订单
    if (!prevStatus) {
        let text
        if (order.status === 'pending_confirm') {
            text = `盘中信号：${name} ${action}信号` +
                (signalName ? `（${signalName}）` : '') +
                (price ? `，参考价 ${price}` : '') +
                (shares ? `，${shares} 股` : '') +
                '，请到持仓系统确认。'
        } else {
            text = `交易提醒：${name} ${action}委托已提交` +
                (signalName ? `（${signalName}）` : '') +
                (price ? `，价格 ${price}` : '') +
                (shares ? `，${shares} 股` : '') + '。'
        }
        return { text, emotion: order.action === 'sell' ? 'sad' : 'happy' }
    }

    // 状态变化
    if (prevStatus === order.status) return null
    if (order.status === 'filled' || order.status === 'partial') {
        const filledPrice = fmtPrice(order.filled_price)
        const filledShares = fmtShares(order.filled_shares)
        return {
            text: `成交播报：${name} ${action}已成交` +
                (filledPrice ? `，成交价 ${filledPrice}` : '') +
                (filledShares ? `，${filledShares} 股` : '') + '。',
            emotion: order.action === 'sell' ? 'sad' : 'happy',
        }
    }
    if (order.status === 'rejected' || order.status === 'cancelled' || order.status === 'expired' || order.status === 'error') {
        return {
            text: `订单更新：${name} ${action}订单${ORDER_STATUS_TEXT[order.status] ?? order.status}。`,
            emotion: 'neutral',
        }
    }
    return null
}

async function fetchJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    return await res.json()
}

async function pushSay(text, emotion) {
    const res = await fetch(`${CONTROL_URL}/internal/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, emotion }),
        signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`/internal/say HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
}

async function pollOnce(state, seedOnly = false) {
    const data = await fetchJson(`${QUANT_API_BASE}/api/real-quant/orders?limit=100`)
    if (!data?.success) throw new Error(`real-quant orders 接口返回异常: ${JSON.stringify(data).slice(0, 200)}`)
    const orders = data.data?.orders ?? []

    let announced = 0
    for (const order of orders) {
        const id = String(order.id)
        const prev = state.orders[id]
        state.orders[id] = order.status
        if (SEMI_ONLY && order.execution_mode !== 'semi') continue
        if (seedOnly) continue // 首轮：只记录基线，不播报历史
        const announcement = orderToAnnouncement(order, prev)
        if (announcement) {
            console.log(`[broadcaster] 播报 #${id}: ${announcement.text}`)
            try {
                await pushSay(announcement.text, announcement.emotion)
                announced += 1
            } catch (err) {
                // 播报失败不更新 prev，下轮重试
                if (prev === undefined) delete state.orders[id]
                else state.orders[id] = prev
                throw err
            }
        }
    }
    return announced
}

async function main() {
    console.log(`[broadcaster] 启动: 量化系统=${QUANT_API_BASE} 控制口=${CONTROL_URL} 间隔=${INTERVAL_MS}ms semiOnly=${SEMI_ONLY}`)
    const state = loadState()
    const firstRun = Object.keys(state.orders).length === 0
    if (firstRun) console.log('[broadcaster] 首轮运行：仅记录历史订单基线，不播报')

    const tick = async () => {
        try {
            const announced = await pollOnce(state, firstRun)
            if (announced > 0 || firstRun) saveState(state)
        } catch (err) {
            console.error(`[broadcaster] 轮询失败: ${err.message}`)
        }
    }

    await tick()
    setInterval(tick, INTERVAL_MS)
}

main().catch((err) => {
    console.error('[broadcaster] 致命错误:', err)
    process.exit(1)
})
