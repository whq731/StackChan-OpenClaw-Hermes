/**
 * openclaw.ts — DEPRECATED: use agent_client.ts instead.
 *
 * This file re-exports AgentHttpClient as OpenClawClient for backwards compatibility.
 * New code should import from agent_client.ts directly.
 *
 * The class was renamed because it's no longer OpenClaw-specific — it talks to
 * any OpenAI-compatible HTTP endpoint (OpenClaw, Hermes/Venus, etc.).
 * See agent_client.ts for the full implementation and backend profiles.
 */

export { AgentHttpClient as OpenClawClient, type HermesSessionClient, type HermesPromptStreamEvent } from './agent_client.js'