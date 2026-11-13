// Capture recorder: subscribes to a device's management /device WebSocket, decodes
// every packet through packet-codec, and writes a time-ordered JSONL capture.
//
// It also reads annotations from stdin: type a line while operating the appliance
// (e.g. "turning fan to high") and it is recorded as a `note` event, time-aligned
// with the byte stream — the raw material for field inference.
//
// Usage:
//   tsx tools/rethink-capture.ts [--cloud] [--state <path>] <mgmt-host[:port]> <device-uuid> [out.jsonl]
//
// The /device WS is served on the management port (default 44401). It emits
//   {rx, injected, type} = device->cloud (fromDevice),  {tx, injected, type} = cloud->device (toDevice),
//   {status:'online'|'offline', meta}.
// `type` is 'packet', or 'ack' for the cloud's delivery ack forwarded to a bridged ThinQ2 device.
//
// With --cloud the recorder also attaches to the real LG cloud's notification feed and
// records {k:'cloud'} events on the same clock, so each fromDevice packet can be labelled
// by the cloud's decoded interpretation. If not logged in yet, it runs the interactive
// login (prompts for the country code, then the post-login URL) ONCE, up front — before
// stdin is taken over for notes. If the cloud login/connect fails, the recorder exits
// with an error rather than continuing a degraded capture.

import WebSocket from 'ws'
import * as fs from 'node:fs'
import readline from 'node:readline'
import { decodePacket } from '@/util/packet-codec'
import { connect as connectCloud, login } from '@/util/lgcloud/monitor'
import { loadState, saveState } from '@/util/lgcloud/state'

// minimal flag parse; the rest are positional
//   --cloud         enable cloud correlation (logs in interactively if not already)
//   --state <path>   override the oauth.json state location
let cloud = false
let statePath: string | undefined
const positionals: string[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--cloud') cloud = true
    else if (a === '--state') statePath = argv[++i]
    else if (a.startsWith('--state=')) statePath = a.slice('--state='.length)
    else positionals.push(a)
}
const [hostArg, deviceId, outArg] = positionals
if (!hostArg || !deviceId) {
    console.error(
        'Usage: tsx tools/rethink-capture.ts [--cloud] [--state <path>] <mgmt-host[:port]> <device-uuid> [out.jsonl]',
    )
    process.exit(1)
}

const host = hostArg.includes(':') ? hostArg : `${hostArg}:44401`
const out = outArg ?? `capture-${deviceId}-${Date.now()}.jsonl`
const stream = fs.createWriteStream(out, { flags: 'a' })

const SCHEMA_VERSION = 2
function emit(event: object) {
    stream.write(JSON.stringify({ ts: Date.now(), ...event }) + '\n')
}

emit({ k: 'session', v: SCHEMA_VERSION, deviceId, tool: 'rethink-capture/0.3' })

let lastML32Record: Buffer | undefined

function ml32Record(record: Buffer) {
    return {
        hex: record.toString('hex').toUpperCase(),
        offsets: Object.fromEntries(
            [...record].map((value, offset) => [
                offset.toString(16).padStart(2, '0'),
                value.toString(16).padStart(2, '0').toUpperCase(),
            ]),
        ),
    }
}

function recordML32(dir: 'fromDevice' | 'toDevice', raw: string, bodyHex: string) {
    if (dir !== 'fromDevice') return

    const body = Buffer.from(bodyHex, 'hex')
    if (body.length < 2 || body[0] !== 0x40) return

    const frame = `40${body[1].toString(16).padStart(2, '0').toUpperCase()}`
    if (body[1] === 0xec && body.length === 58) {
        const previous = body.subarray(2, 30)
        const current = body.subarray(30, 58)
        const changedOffsets = lastML32Record
            ? [...current]
                  .map((value, offset) => (value === lastML32Record![offset] ? -1 : offset))
                  .filter((offset) => offset >= 0)
            : [...current.keys()]

        emit({
            k: 'ml32',
            frame,
            hex: raw.toUpperCase(),
            packetLength: raw.length / 2,
            bodyLength: body.length,
            previous: ml32Record(previous),
            current: ml32Record(current),
            changedOffsets,
        })
        logML32(frame, current, changedOffsets)
        lastML32Record = Buffer.from(current)
    } else if (body[1] === 0xeb && body.length === 30) {
        const current = body.subarray(2, 30)
        const changedOffsets = lastML32Record
            ? [...current]
                  .map((value, offset) => (value === lastML32Record![offset] ? -1 : offset))
                  .filter((offset) => offset >= 0)
            : [...current.keys()]

        emit({
            k: 'ml32',
            frame,
            hex: raw.toUpperCase(),
            packetLength: raw.length / 2,
            bodyLength: body.length,
            current: ml32Record(current),
            changedOffsets,
        })
        logML32(frame, current, changedOffsets)
        lastML32Record = Buffer.from(current)
    } else if (body[1] === 0xbf || body[1] === 0x72) {
        emit({
            k: 'ml32',
            frame,
            hex: raw.toUpperCase(),
            packetLength: raw.length / 2,
            bodyLength: body.length,
        })
        console.error(
            `[ML32 ${frame}] packet=${raw.length / 2} bytes body=${body.length} bytes raw=${raw.toUpperCase()}`,
        )
    }
}

function logML32(frame: string, current: Buffer, changedOffsets: number[]) {
    const remaining = current[3] * 3600 + current[4] * 60 + current[5]
    const previousRemaining = lastML32Record
        ? lastML32Record[3] * 3600 + lastML32Record[4] * 60 + lastML32Record[5]
        : undefined
    const significantChange = changedOffsets.some((offset) => offset < 3 || offset > 5)
    const minuteChanged =
        previousRemaining === undefined || Math.floor(previousRemaining / 60) !== Math.floor(remaining / 60)
    if (!significantChange && !minuteChanged && remaining > 10) return

    console.error(
        `[ML32 ${frame}] changed=${changedOffsets.map((offset) => offset.toString(16).padStart(2, '0')).join(',') || '-'} ` +
            `status=${current[0].toString(16).padStart(2, '0')} context=${current[1].toString(16).padStart(2, '0')}/${current[2].toString(16).padStart(2, '0')} ` +
            `remaining=${current[3].toString().padStart(2, '0')}:${current[4].toString().padStart(2, '0')}:${current[5].toString().padStart(2, '0')} ` +
            `target=${current[6].toString(16).padStart(2, '0')}`,
    )
}

type ApplicationEvent = {
    direction: 'fromDevice' | 'toDevice'
    qos: 0 | 1 | 2
    retain: boolean
    payload: string
}

function isApplicationEvent(value: unknown): value is ApplicationEvent {
    if (!value || typeof value !== 'object') return false
    const event = value as Record<string, unknown>
    return (
        (event.direction === 'fromDevice' || event.direction === 'toDevice') &&
        (event.qos === 0 || event.qos === 1 || event.qos === 2) &&
        typeof event.retain === 'boolean' &&
        typeof event.payload === 'string'
    )
}

function recordApplication(event: ApplicationEvent, injected: boolean) {
    const payload = Buffer.from(event.payload, 'base64')
    const text = payload.toString('utf8').replace(/\0+$/, '')
    let message: unknown
    try {
        message = JSON.parse(text)
    } catch {}

    emit({
        k: 'application',
        dir: event.direction,
        injected,
        qos: event.qos,
        retain: event.retain,
        encoding: 'base64',
        payload: event.payload,
        ...(message === undefined ? { text } : { message }),
    })
}

// A `wire` event: decode the hex and fold the decoded view in, but keep the raw hex.
function recordWire(dir: 'fromDevice' | 'toDevice', type: 'packet' | 'ack', raw: string, injected: boolean) {
    // Non-hex payloads (T1 object frames the WS stringifies) are stored verbatim.
    if (!/^[0-9a-fA-F]*$/.test(raw)) {
        emit({ k: 'wire', dir, type, injected, raw })
        return
    }
    const decoded = decodePacket(raw)
    if (decoded.protocol === 'tlv') {
        emit({
            k: 'wire',
            dir,
            type,
            injected,
            hex: raw,
            protocol: 'tlv',
            crcOk: decoded.crcOk,
            frame: decoded.frame,
            tlv: decoded.tlv,
        })
    } else if (decoded.protocol === 'aabb') {
        emit({
            k: 'wire',
            dir,
            type,
            injected,
            hex: raw,
            protocol: 'aabb',
            checksumOk: decoded.checksumOk,
            body: decoded.body,
        })
        if (type === 'packet') recordML32(dir, raw, decoded.body)
    } else {
        emit({ k: 'wire', dir, type, injected, hex: raw, protocol: 'unknown' })
    }
}

const url = `ws://${host}/device?id=${encodeURIComponent(deviceId)}`
console.error(`Connecting to ${url}\nWriting capture to ${out}`)

const ws = new WebSocket(url)

ws.on('open', () => emit({ k: 'marker', phase: 'connected' }))

ws.on('message', (data: WebSocket.RawData) => {
    let msg: any
    try {
        msg = JSON.parse(data.toString())
    } catch {
        return
    }
    // older rethink servers send no type; everything was a packet
    const type = msg.type === 'ack' ? 'ack' : 'packet'
    if (typeof msg.rx === 'string') recordWire('fromDevice', type, msg.rx, !!msg.injected)
    else if (typeof msg.tx === 'string') recordWire('toDevice', type, msg.tx, !!msg.injected)
    else if (isApplicationEvent(msg.application)) recordApplication(msg.application, !!msg.injected)
    else if (msg.status) emit({ k: 'marker', phase: msg.status, meta: msg.meta })
})

ws.on('close', () => {
    emit({ k: 'marker', phase: 'disconnected' })
    stream.end()
    process.exit(0)
})
ws.on('error', (err) => {
    console.error('WebSocket error:', err.message)
    process.exit(1)
})

process.on('SIGINT', () => {
    emit({ k: 'marker', phase: 'stopped' })
    stream.end(() => process.exit(0))
})

// Begin reading stdin for note events. Called only AFTER any interactive cloud login has
// finished, so the login's prompts and the note reader never contend for stdin.
function startNotes() {
    const rl = readline.createInterface({ input: process.stdin })
    rl.on('line', (line) => {
        const text = line.trim()
        if (text) emit({ k: 'note', author: 'human', text })
    })
    console.error('Type annotations and press enter; Ctrl-C to stop.')
}

// Optional cloud-oracle correlation. Interactive: logs in (prompting for country code +
// post-login URL) if there are no stored credentials, then connects. Any failure throws.
async function setupCloud() {
    if (!cloud) return
    let state = loadState(statePath)
    if (!state) {
        console.error('[cloud] no stored credentials — logging in now (before note capture starts)')
        state = await login()
        saveState(state, statePath)
        emit({ k: 'marker', phase: 'cloud-logged-in' })
    }
    await connectCloud(state, {
        log: (m) => console.error(`[cloud] ${m}`),
        onMessage: ({ topic, payload, raw }) => {
            // best-effort attribution: does this notification mention our device?
            const matchesDevice = raw.includes(deviceId)
            if (payload !== null) emit({ k: 'cloud', topic, matchesDevice, state: payload })
            else emit({ k: 'cloud', topic, matchesDevice, text: raw })
        },
    })
    emit({ k: 'marker', phase: 'cloud-connected' })
}

setupCloud().then(
    () => startNotes(),
    (err) => {
        console.error(`[cloud] login/connect failed: ${err.message}`)
        emit({ k: 'marker', phase: 'cloud-failed', reason: err.message })
        stream.end(() => process.exit(1))
    },
)
