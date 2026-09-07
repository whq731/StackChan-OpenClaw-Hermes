/**
 * Local TTS audio output — macOS implementation.
 *
 * Plays TTS wav buffers to the Mac's CURRENT default output device (the one
 * selected in System Settings → Sound → Output).  This lets the user pick the
 * destination purely from macOS UI: built-in speakers, a Bluetooth/USB speaker,
 * AirPlay, etc. — no device ID plumbing needed on our side.
 *
 * afplay cannot read from stdin, so each wav buffer is written to a temp file,
 * played, then removed.
 */
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

export type LocalTtsOutputConfig = {
    enabled: boolean
    targetName: string
    volume: number
    fallbackM5Volume: number
}

export function readLocalTtsOutputConfig(
    env: Record<string, string | undefined> = process.env,
): LocalTtsOutputConfig {
    const volume = Number(env['STACKCHAN_LOCAL_TTS_OUTPUT_VOLUME'] ?? '0.35')
    const fallbackM5Volume = Number(env['STACKCHAN_LOCAL_TTS_FALLBACK_M5_VOLUME'] ?? '62')
    return {
        enabled: /^(1|true|yes|on)$/i.test(env['STACKCHAN_LOCAL_TTS_OUTPUT_ENABLED']?.trim() ?? ''),
        targetName: env['STACKCHAN_LOCAL_TTS_OUTPUT_TARGET_NAME']?.trim() || 'Mac default output',
        volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.35,
        fallbackM5Volume: Number.isFinite(fallbackM5Volume)
            ? Math.max(0, Math.min(100, Math.round(fallbackM5Volume)))
            : 62,
    }
}

/**
 * Run a command, capturing stdout/stderr and the real exit code/signal.
 *
 * NO artificial timeout: afplay blocks until the (possibly several-second-long)
 * wav finishes. A timeout here would SIGKILL afplay mid-utterance and look like
 * a "playback failed", which the caller treats as "fall back to the device
 * speaker" — exactly the "前半段出声后半段切回设备" symptom we saw.
 */
function runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', (error) => reject(error))
        child.on('close', (code, signal) => {
            if (code === 0) {
                resolve()
                return
            }
            const detail = Buffer.concat(stderr).toString('utf8').trim()
                || Buffer.concat(stdout).toString('utf8').trim()
                || `code=${code} signal=${signal}`
            reject(new Error(`${command} ${args.join(' ')} exited ${detail}`))
        })
    })
}

/** Placeholder target token; afplay always plays to the Mac system default output. */
const MAC_DEFAULT_OUTPUT = 'mac-default'

export async function resolveLocalTtsOutputTarget(config: LocalTtsOutputConfig): Promise<string | null> {
    if (!config.enabled) return null
    try {
        // afplay ships with macOS at a fixed path; verify presence without relying
        // on afplay's own (non-zero) exit code for --help.
        await fs.access('/usr/bin/afplay')
    } catch {
        return null
    }
    return MAC_DEFAULT_OUTPUT
}

export async function playWavOnLocalTarget(_target: string, wav: Buffer): Promise<void> {
    const tmpDir = os.tmpdir()
    const tmpFile = path.join(
        tmpDir,
        `stackchan-local-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
    )
    try {
        await fs.writeFile(tmpFile, wav)
        // afplay -v takes 0..1; clamp for safety.
        const volume = readLocalTtsOutputConfig().volume
        const vol = Math.max(0, Math.min(1, volume))
        await runCommand('afplay', ['-v', vol.toFixed(3), tmpFile])
    } finally {
        await fs.rm(tmpFile, { force: true }).catch(() => {})
    }
}
