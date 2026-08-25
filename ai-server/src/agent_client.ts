/**
 * AgentHttpClient — Generic OpenAI-compatible HTTP client for Stack-chan ai-server.
 *
 * Talks to any backend that implements the OpenAI `/v1/chat/completions` endpoint:
 *   - OpenClaw Gateway  (model: "openclaw/<agent_id>", headers: x-openclaw-session-key)
 *   - Hermes dedicated-port profile e.g. Venus  (model: "hermes-agent", headers: X-Hermes-Session-Key)
 *
 * The backend difference is encapsulated in two fields:
 *   - sessionHeaderName  — which HTTP header carries the session key
 *   - sessionKeyFormat   — how the session-key string is built from agent/device IDs
 *
 * If OpenClaw or Hermes diverge further (e.g. different auth schemes, custom
 * request bodies, non-standard SSE fields), create a SEPARATE client class rather
 * than piling more conditionals into this one. This file stays generic; backend
 * specifics go in their own files. See ADR-001 for rationale.
 */

export type HermesPromptStreamEvent =
    | { type: 'delta'; text: string }
    | { type: 'complete'; text?: string }

export type HermesSessionClient = {
    submitPrompt(prompt: string): Promise<string>
    streamPrompt?(prompt: string): AsyncIterable<HermesPromptStreamEvent>
    interrupt(): Promise<void>
    dispose(): Promise<void>
}

/**
 * Backend profile — describes how to reach a specific OpenAI-compatible API.
 *
 * OpenClaw and Hermes both speak the OpenAI chat completions protocol, but they
 * differ in:
 *   - session-key header name (x-openclaw-session-key vs X-Hermes-Session-Key)
 *   - session-key format (agent:<id>:stackchan:<dev> vs <agent>-stackchan-<dev>)
 *   - model naming (openclaw/<agent_id> vs hermes-agent)
 *
 * These presets capture those differences so the HTTP client stays generic.
 */
export type BackendProfile = {
    /** Display name for logs and errors */
    label: string
    /** Session-key HTTP header name */
    sessionHeaderName: string
    /** Session-key template: {agent} and {device} are substituted */
    sessionKeyFormat: string
}

/** Pre-defined backend profiles for known OpenAI-compatible gateways */
export const BACKEND_PROFILES: Record<string, BackendProfile> = {
    openclaw: {
        label: 'OpenClaw',
        sessionHeaderName: 'x-openclaw-session-key',
        sessionKeyFormat: 'agent:{agent}:stackchan:{device}',
    },
    hermes: {
        label: 'Hermes',
        sessionHeaderName: 'X-Hermes-Session-Key',
        sessionKeyFormat: '{agent}-stackchan-{device}',
    },
}

export class AgentHttpClient implements HermesSessionClient {
    private controller: AbortController | null = null
    private readonly baseUrl: string
    private readonly apiKey: string
    private readonly model: string
    private readonly sessionKey: string
    private readonly sessionHeaderName: string
    private readonly label: string

    constructor(options?: {
        host?: string
        port?: string | number
        apiKey?: string
        model?: string
        agentId?: string
        deviceId?: string
        /** Backend profile key — 'openclaw' | 'hermes' (see BACKEND_PROFILES) */
        backend?: string
        /** Override the session-key header name directly */
        sessionHeaderName?: string
        /** Override the session-key format directly (use {agent} and {device}) */
        sessionKeyFormat?: string
    }) {
        const host = options?.host ?? process.env.OPENCLAW_HOST ?? '127.0.0.1'
        const port = options?.port ?? process.env.OPENCLAW_PORT ?? '18789'
        this.baseUrl = `http://${host}:${port}`
        this.apiKey = options?.apiKey ?? process.env.OPENCLAW_API_KEY ?? ''
        this.model = options?.model ?? process.env.OPENCLAW_MODEL ?? 'openclaw/your-agent'
        const agentId = options?.agentId ?? process.env.OPENCLAW_AGENT_ID ?? 'your-agent'
        const deviceId = options?.deviceId ?? process.env.STACKCHAN_DEVICE_ID ?? 'default'

        // Resolve backend profile — explicit overrides take precedence
        const profile = options?.backend ? BACKEND_PROFILES[options.backend] : undefined
        this.sessionHeaderName = options?.sessionHeaderName
            ?? profile?.sessionHeaderName
            ?? 'x-openclaw-session-key'
        this.sessionKey = options?.sessionKeyFormat
            ? options.sessionKeyFormat.replace('{agent}', agentId).replace('{device}', deviceId)
            : profile?.sessionKeyFormat
                ? profile.sessionKeyFormat.replace('{agent}', agentId).replace('{device}', deviceId)
                : `agent:${agentId}:stackchan:${deviceId}`
        this.label = profile?.label ?? 'Agent'
    }

    async submitPrompt(prompt: string): Promise<string> {
        this.controller = new AbortController()
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                [this.sessionHeaderName]: this.sessionKey,
            },
            body: JSON.stringify({
                model: this.model,
                stream: false,
                messages: [{ role: 'user', content: prompt }],
            }),
            signal: this.controller.signal,
        })
        if (!response.ok) {
            throw new Error(`${this.label} request failed: HTTP ${response.status}`)
        }
        const data = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>
            error?: { message?: string }
        }
        if (data.error) {
            throw new Error(`${this.label} error: ${data.error.message ?? 'unknown error'}`)
        }
        const content = data?.choices?.[0]?.message?.content
        if (typeof content !== 'string') throw new Error(`${this.label} returned no content`)
        return content
    }

    async *streamPrompt(prompt: string): AsyncGenerator<HermesPromptStreamEvent> {
        this.controller = new AbortController()
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                [this.sessionHeaderName]: this.sessionKey,
            },
            body: JSON.stringify({
                model: this.model,
                stream: true,
                messages: [{ role: 'user', content: prompt }],
            }),
            signal: this.controller.signal,
        })
        if (!response.ok) {
            throw new Error(`${this.label} request failed: HTTP ${response.status}`)
        }

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let fullText = ''
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() ?? ''
                for (const line of lines) {
                    // Accept both "data: " and "data:" prefixes (SSE spec allows both)
                    const trimmed = line.trim()
                    if (!trimmed.startsWith('data:')) continue
                    const data = trimmed.slice(5).trim()
                    if (data === '[DONE]') {
                        yield { type: 'complete', text: fullText }
                        return
                    }
                    try {
                        const json = JSON.parse(data) as {
                            choices?: Array<{ delta?: { content?: string } }>
                        }
                        const delta = json?.choices?.[0]?.delta?.content
                        if (typeof delta === 'string' && delta) {
                            fullText += delta
                            yield { type: 'delta', text: delta }
                        }
                    } catch {
                        // skip malformed SSE lines
                    }
                }
            }
            // Stream ended without [DONE] — emit complete with accumulated text
            yield { type: 'complete', text: fullText }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return
            throw error
        }
    }

    async interrupt(): Promise<void> {
        this.controller?.abort()
    }

    async dispose(): Promise<void> {
        this.controller?.abort()
    }
}