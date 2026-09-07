"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentHttpClient = exports.BACKEND_PROFILES = void 0;
/** Pre-defined backend profiles for known OpenAI-compatible gateways */
exports.BACKEND_PROFILES = {
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
};
class AgentHttpClient {
    controller = null;
    baseUrl;
    apiKey;
    model;
    sessionKey;
    sessionHeaderName;
    label;
    constructor(options) {
        const host = options?.host ?? process.env.OPENCLAW_HOST ?? '127.0.0.1';
        const port = options?.port ?? process.env.OPENCLAW_PORT ?? '18789';
        this.baseUrl = `http://${host}:${port}`;
        this.apiKey = options?.apiKey ?? process.env.OPENCLAW_API_KEY ?? '';
        this.model = options?.model ?? process.env.OPENCLAW_MODEL ?? 'openclaw/your-agent';
        const agentId = options?.agentId ?? process.env.OPENCLAW_AGENT_ID ?? 'your-agent';
        const deviceId = options?.deviceId ?? process.env.STACKCHAN_DEVICE_ID ?? 'default';
        // Resolve backend profile — explicit overrides take precedence
        const profile = options?.backend ? exports.BACKEND_PROFILES[options.backend] : undefined;
        this.sessionHeaderName = options?.sessionHeaderName
            ?? profile?.sessionHeaderName
            ?? 'x-openclaw-session-key';
        this.sessionKey = options?.sessionKeyFormat
            ? options.sessionKeyFormat.replace('{agent}', agentId).replace('{device}', deviceId)
            : profile?.sessionKeyFormat
                ? profile.sessionKeyFormat.replace('{agent}', agentId).replace('{device}', deviceId)
                : `agent:${agentId}:stackchan:${deviceId}`;
        this.label = profile?.label ?? 'Agent';
    }
    async submitPrompt(prompt) {
        this.controller = new AbortController();
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
        });
        if (!response.ok) {
            throw new Error(`${this.label} request failed: HTTP ${response.status}`);
        }
        const data = await response.json();
        if (data.error) {
            throw new Error(`${this.label} error: ${data.error.message ?? 'unknown error'}`);
        }
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string')
            throw new Error(`${this.label} returned no content`);
        return content;
    }
    async *streamPrompt(prompt) {
        this.controller = new AbortController();
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
        });
        if (!response.ok) {
            throw new Error(`${this.label} request failed: HTTP ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    // Accept both "data: " and "data:" prefixes (SSE spec allows both)
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:'))
                        continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') {
                        yield { type: 'complete', text: fullText };
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const delta = json?.choices?.[0]?.delta?.content;
                        if (typeof delta === 'string' && delta) {
                            fullText += delta;
                            yield { type: 'delta', text: delta };
                        }
                    }
                    catch {
                        // skip malformed SSE lines
                    }
                }
            }
            // Stream ended without [DONE] — emit complete with accumulated text
            yield { type: 'complete', text: fullText };
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError')
                return;
            throw error;
        }
    }
    async interrupt() {
        this.controller?.abort();
    }
    async dispose() {
        this.controller?.abort();
    }
}
exports.AgentHttpClient = AgentHttpClient;
