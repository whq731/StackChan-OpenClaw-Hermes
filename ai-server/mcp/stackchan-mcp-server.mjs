#!/usr/bin/env node
/**
 * StackChan MCP Server (stdio) — xiaozhi 体系版
 *
 * 把 ai-server 的内部控制 HTTP（127.0.0.1:8766）封装成标准 MCP 工具，
 * 供 OpenClaw main agent 原生调用：say / followup / head / led / photo ...
 *
 * 对应旧方案（~/.openclaw/workspace/stackchan-bridge）的 stackchan_say / stackchan_face，
 * 但后端从 Migro MCP gateway 换成了本仓库 ai-server 的会话桥。
 *
 * 工具调用失败（设备待机未连线）时返回可读错误，agent 可自行降级处理。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const CONTROL_BASE = process.env.STACKCHAN_CONTROL_URL ?? 'http://127.0.0.1:8766'

const EMOTIONS = ['neutral', 'happy', 'laughing', 'angry', 'sad', 'crying', 'sleepy', 'doubtful']

async function controlFetch(path, init) {
    let res
    try {
        res = await fetch(`${CONTROL_BASE}${path}`, init)
    } catch (error) {
        throw new Error(`ai-server (${CONTROL_BASE}) unreachable: ${error.message}`)
    }
    const text = await res.text()
    let body = null
    try {
        body = JSON.parse(text)
    } catch {
        body = { raw: text }
    }
    if (!res.ok) {
        const detail = body?.error ?? text.slice(0, 200)
        throw new Error(`HTTP ${res.status}: ${detail}`)
    }
    return body
}

async function callTool(name, args = {}) {
    const body = await controlFetch('/tools/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, args }),
    })
    return body.result ?? body
}

const TOOLS = [
    {
        name: 'stackchan_say',
        description:
            '让 StackChan 桌面机器人直接说话（本地 TTS，可选表情）。适合播报、提醒、简短回应。' +
            '文本会自动分句播报；设备待机未连线时会报错，可用 stackchan_get_status 先确认。',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '要说的内容（中文为主，最长 800 字）' },
                emotion: { type: 'string', enum: EMOTIONS, description: '说话时的表情' },
            },
            required: ['text'],
        },
    },
    {
        name: 'stackchan_followup',
        description:
            '向瓦力投递一条 prompt，让它经过 LLM 思考后开口回答（而不是照念文本）。适合需要推理/上下文的回应。',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: '投递给对话链路的 prompt（最长 12000 字）' },
            },
            required: ['prompt'],
        },
    },
    {
        name: 'stackchan_get_status',
        description: '查询机器人连接状态：是否在线、当前状态机（listening/processing/idle）、队列等。',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'stackchan_get_head_angles',
        description: '读取机器人头部当前 yaw/pitch 角度。',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'stackchan_set_head_angles',
        description: '控制机器人头部转动。yaw 左右、pitch 上下，单位度。',
        inputSchema: {
            type: 'object',
            properties: {
                yaw: { type: 'number', description: '水平角度（度）' },
                pitch: { type: 'number', description: '俯仰角度（度）' },
            },
        },
    },
    {
        name: 'stackchan_set_led_color',
        description: '设置机器人底部 RGB 灯环颜色（0-255）。',
        inputSchema: {
            type: 'object',
            properties: {
                r: { type: 'number' },
                g: { type: 'number' },
                b: { type: 'number' },
            },
            required: ['r', 'g', 'b'],
        },
    },
    {
        name: 'stackchan_set_speaker_volume',
        description: '设置扬声器音量（0-100）。',
        inputSchema: {
            type: 'object',
            properties: { volume: { type: 'number' } },
            required: ['volume'],
        },
    },
    {
        name: 'stackchan_take_photo',
        description: '让机器人拍摄一张照片（CoreS3 摄像头），返回图片引用。',
        inputSchema: { type: 'object', properties: {} },
    },
]

const server = new Server(
    { name: 'stackchan-xiaozhi', version: '1.0.0' },
    { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
        let result
        switch (name) {
            case 'stackchan_say': {
                const text = typeof args?.text === 'string' ? args.text.trim() : ''
                if (!text) throw new Error('text is required')
                const emotion = EMOTIONS.includes(args?.emotion) ? args.emotion : undefined
                await controlFetch('/internal/say', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ text, emotion }),
                })
                result = { spoken: true, text, emotion: emotion ?? 'neutral' }
                break
            }
            case 'stackchan_followup': {
                const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
                if (!prompt) throw new Error('prompt is required')
                await controlFetch('/internal/followup', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ prompt }),
                })
                result = { queued: true, prompt: prompt.slice(0, 120) }
                break
            }
            case 'stackchan_get_status': {
                const body = await controlFetch('/internal/status')
                result = body.result ?? body
                break
            }
            case 'stackchan_get_head_angles':
                result = await callTool('stackchan_get_head_angles', {})
                break
            case 'stackchan_set_head_angles':
                result = await callTool('stackchan_set_head_angles', {
                    yaw: Number(args?.yaw ?? 0),
                    pitch: Number(args?.pitch ?? 0),
                })
                break
            case 'stackchan_set_led_color':
                result = await callTool('stackchan_set_led_color', {
                    r: Number(args?.r ?? 0),
                    g: Number(args?.g ?? 0),
                    b: Number(args?.b ?? 0),
                })
                break
            case 'stackchan_set_speaker_volume':
                result = await callTool('stackchan_set_speaker_volume', {
                    volume: Number(args?.volume ?? 50),
                })
                break
            case 'stackchan_take_photo':
                result = await callTool('stackchan_take_photo', {})
                break
            default:
                throw new Error(`unknown tool: ${name}`)
        }
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }
    } catch (error) {
        return {
            content: [{ type: 'text', text: `stackchan tool failed: ${error.message}` }],
            isError: true,
        }
    }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[stackchan-mcp] ready, control base:', CONTROL_BASE)
