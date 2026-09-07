"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenClawClient = void 0;
var agent_client_js_1 = require("./agent_client.js");
Object.defineProperty(exports, "OpenClawClient", { enumerable: true, get: function () { return agent_client_js_1.AgentHttpClient; } });
