"use strict";
// ota_config.ts — Local OTA/config endpoint for StackChan (xiaozhi-esp32) devices.
//
// The xiaozhi firmware calls Ota::CheckVersion() on boot: it POSTs its system-info
// JSON to whatever `ota_url` is compiled/configured in NVS (`wifi.ota_url`), then
// selects a protocol from the JSON response:
//   - response contains `mqtt`      -> MqttProtocol (official cloud)
//   - else response contains `websocket` -> WebsocketProtocol (local ai-server)
//
// To force the device onto our local WebSocket bridge we answer with a `websocket`
// object only (NO `mqtt` section, NO `firmware` section so no spurious self-upgrade)
// pointing at this ai-server's own /ws endpoint.
//
// The device caches this into NVS namespace `websocket` and on reconnect reads:
//   url     -> ws://host:8765/ws
//   token   -> optional; sent as `Authorization: Bearer <token>` (may be empty)
//   version -> binary protocol version, must equal this server's Session.version (=3)
Object.defineProperty(exports, "__esModule", { value: true });
exports.serveOtaRequest = serveOtaRequest;
// Advertised WS base for the device to connect to. Defaults to whatever host the
// device itself used to reach us (its Host header, e.g. "192.168.1.50:8765"), which
// is the most reliable address on a LAN. Override with STACKCHAN_WS_ADVERTISE_HOST
// if the device cannot reach us via the Host it already used for this request.
function advertisedWsBase(hostHeader) {
    const override = process.env.STACKCHAN_WS_ADVERTISE_HOST?.trim();
    if (override)
        return override.replace(/\/+$/, '');
    const host = hostHeader?.trim();
    if (host)
        return host.replace(/\/+$/, '');
    return `127.0.0.1:${process.env.PORT ?? '8765'}`;
}
function serveOtaRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Accept both /ota and a trailing variant; firmware appends no extra path.
    if (url.pathname !== '/ota' && url.pathname !== '/ota/')
        return false;
    // The request body carries the device system-info JSON. We do not need its
    // contents to hand back a static config, but drain it so keep-alive reuses
    // the socket cleanly.
    req.on('data', () => { });
    const wsBase = advertisedWsBase(req.headers.host);
    const wsUrl = `ws://${wsBase}/ws`;
    const token = process.env.STACKCHAN_WS_TOKEN ?? '';
    const version = Number(process.env.STACKCHAN_WS_VERSION ?? '3');
    const payload = {
        websocket: {
            url: wsUrl,
            ...(token ? { token } : {}),
            version,
        },
        // Intentionally NO `mqtt` and NO `firmware` keys:
        //   - omitting mqtt makes the firmware choose WebsocketProtocol
        //   - omitting firmware avoids any self-upgrade / "new version" checks
    };
    const body = JSON.stringify(payload);
    res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
    });
    res.end(body);
    console.log(`[ota] served websocket config: ${wsUrl} (version=${version})`);
    return true;
}
