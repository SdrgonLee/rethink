import HADevice from './base'
import AABBDevice from './aabb_device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { Device as Thinq2Device } from '../thinq2/device'
import { allowExtendedType } from '@/util/casting'

// LG FX25 front-load washer (modelId FX___N, protocolVer 7).
//
// The appliance uses the same unified washer state layout as LG's newer laundry products, but with a
// 67-byte washer-only block. Captured frame types:
//   0x55  state resync: 13-byte header + one 67-byte state block + trailer
//   0x98  state update: 13-byte header + old block + current block + trailer
//   0xE6  compact state snapshot: 9-byte header + one 67-byte state block
//   0x18  door event: inner[18] is 1=open, 2=closed
//
// Offsets were established from a labelled power/door capture and checked against FX___N ModelJSON.
// This handler is intentionally read-only: no command frames have been captured and verified yet.

const HEADER_LENGTH = 13
const COMPACT_HEADER_LENGTH = 9
const STATE_BLOCK_LENGTH = 67
const RESYNC_TYPE = 0x55
const UPDATE_TYPE = 0x98
const COMPACT_TYPE = 0xe6
const DOOR_TYPE = 0x18
const DOOR_OFFSET = 18

const SOIL: Record<number, string> = {
    0: 'None',
    1: 'Light',
    3: 'Normal',
    5: 'Heavy',
    6: 'Pre-wash',
    7: 'Soaking',
}

const SPIN: Record<number, number> = {
    0: 0,
    1: 400,
    2: 600,
    4: 800,
    6: 1000,
    8: 1200,
}

const TEMPERATURE: Record<number, string | number> = {
    0: 'unknown',
    2: 30,
    3: 40,
    5: 60,
    6: 95,
    8: 'Cold',
}

const COURSE: Record<number, string> = {
    0x08: 'Baby Care',
    0x1b: 'Duvet',
    0x2e: 'Normal',
    0x37: 'Rinse + Spin',
    0x4a: 'Speed Wash',
    0x4c: 'Speed Boil',
    0x4e: 'Spin Only',
    0x55: 'Tub Clean',
    0x5e: 'Wool',
    0x72: 'AI Wash',
    0x88: 'Microplastic Care',
}

const STATUS: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Initial',
    0x02: 'Paused',
    0x03: 'Detecting',
    0x05: 'Draining',
    0x06: 'Detecting detergent amount',
    0x07: 'Reserved',
    0x08: 'Soaking',
    0x09: 'Pre-wash',
    0x0b: 'Washing',
    0x0c: 'Rinsing',
    0x0d: 'Rinse hold',
    0x0e: 'Spinning',
    0x0f: 'Drying',
    0x10: 'Complete',
    0x15: 'Fresh care',
    0x17: 'Error auto-off',
    0x1b: 'Freeze prevention initial',
    0x1c: 'Freeze prevention paused',
    0x1d: 'Freeze prevention running',
    0x22: 'Audible diagnosis',
    0x23: 'Auto detergent open pause',
    0x24: 'Waiting for control',
    0x25: 'Detecting load',
    0x26: 'Adding detergent',
    0x27: 'Adding softener',
    0x28: 'Detecting soil',
    0x29: 'Tub cleaning',
    0x2a: 'Complete',
    0x2b: 'Steam',
    0x2f: 'Laundry care',
    0x30: 'EzDispense cleaning',
    0x31: 'Waiting after completion',
}

const ERROR: Record<number, string> = {
    // Home Assistant reserves "None" as an unknown state in MQTT sensor values.
    0: 'No error',
    2: 'IE',
    3: 'OE',
    4: 'UE',
    5: 'FE',
    7: 'PE',
    8: 'TE',
    9: 'LE',
    13: 'FF',
    20: 'DE1',
    21: 'DE2',
    23: 'VS',
    43: 'ED1',
    44: 'ED2',
    45: 'ED3',
    46: 'ED4',
    47: 'ED5',
    48: 'TS',
    51: 'E1',
    52: 'E4',
}

function minutes(block: Buffer, offset: number): number {
    return block.readUInt16BE(offset)
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG FX25 Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining-time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        icon: 'mdi:timer-outline',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial-time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        icon: 'mdi:timer-sand',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve-time',
                        state_topic: '$this/reserve_time',
                        name: 'Reserved start time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        icon: 'mdi:clock-outline',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse count',
                        icon: 'mdi:water-sync',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        unit_of_measurement: 'rpm',
                        icon: 'mdi:rotate-right',
                    },
                    temperature: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temperature',
                        state_topic: '$this/temperature',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        value_template: "{{ value if value | is_number else 'None' }}",
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door-lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child-lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote-start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start enabled',
                        icon: 'mdi:remote',
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo-wash',
                        state_topic: '$this/turbo_wash',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre-wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-plus',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    crease_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-crease-care',
                        state_topic: '$this/crease_care',
                        name: 'Crease care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub-clean-count',
                        state_topic: '$this/tub_clean_count',
                        // FX___N calls this TCLCount, while LG's official HA integration exposes
                        // the same counter as "Use count". A complete real cycle incremented both
                        // views from 12 to 13 at the same instant.
                        name: 'Use count',
                        icon: 'mdi:counter',
                    },
                    error: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 4) return

        // Compact snapshots put their type at inner[1], unlike the extended 0x0A envelope. Power
        // snapshots used 20E6000001FF010200, while a real laundry-care transition used
        // 20E6000201FF015700. The subtype-specific bytes differ, so retain the shared framing bytes,
        // exact total length and fixed block position instead of rejecting valid state variants.
        if (
            buf[1] === COMPACT_TYPE &&
            buf.length === COMPACT_HEADER_LENGTH + STATE_BLOCK_LENGTH &&
            buf[4] === 0x01 &&
            buf[5] === 0xff &&
            buf[6] === 0x01 &&
            buf[8] === 0x00
        ) {
            return this.processStateBlock(buf.subarray(COMPACT_HEADER_LENGTH))
        }

        if (buf[3] === DOOR_TYPE) return this.processDoor(buf)
        if (buf[3] === RESYNC_TYPE) {
            if (
                buf.length !== HEADER_LENGTH + STATE_BLOCK_LENGTH + 1 ||
                buf[10] !== 0xeb ||
                buf[11] !== 0x00 ||
                buf[12] !== STATE_BLOCK_LENGTH
            )
                return
            return this.processStateBlock(buf.subarray(HEADER_LENGTH, HEADER_LENGTH + STATE_BLOCK_LENGTH))
        }
        if (buf[3] === UPDATE_TYPE) {
            if (
                buf.length !== HEADER_LENGTH + STATE_BLOCK_LENGTH * 2 + 1 ||
                buf[10] !== 0xec ||
                buf[11] !== 0x00 ||
                buf[12] !== STATE_BLOCK_LENGTH * 2
            )
                return
            const current = HEADER_LENGTH + STATE_BLOCK_LENGTH
            return this.processStateBlock(buf.subarray(current, current + STATE_BLOCK_LENGTH))
        }
    }

    private processDoor(buf: Buffer) {
        if (buf.length <= DOOR_OFFSET) return
        if (buf[DOOR_OFFSET] === 0x01) this.publishProperty('door', 'ON')
        else if (buf[DOOR_OFFSET] === 0x02) this.publishProperty('door', 'OFF')
    }

    private processStateBlock(block: Buffer) {
        if (block.length !== STATE_BLOCK_LENGTH) return

        const state = block[21]
        const isOff = state === 0
        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[state] ?? 'Running')
        this.publishProperty('course', COURSE[block[5]] ?? 'unknown')
        this.publishProperty('remaining_time', isOff ? 0 : minutes(block, 13))
        this.publishProperty('initial_time', isOff ? 0 : minutes(block, 15))
        this.publishProperty('reserve_time', isOff ? 0 : minutes(block, 11))
        this.publishProperty('soil', SOIL[block[1]] ?? 'unknown')
        this.publishProperty('rinse', block[2])
        this.publishProperty('temperature', TEMPERATURE[block[3]] ?? 'unknown')
        this.publishProperty('spin', SPIN[block[4]] ?? 'unknown')
        this.publishProperty('error', ERROR[block[19]] ?? `Unknown (${block[19]})`)
        this.publishProperty('tub_clean_count', block[28])

        this.publishProperty('turbo_wash', (block[34] & 0x20) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (block[34] & 0x40) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (block[35] & 0x10) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('crease_care', (block[36] & 0x80) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (block[37] & 0x20) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (block[37] & 0x10) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', (block[38] & 0x01) !== 0 ? 'ON' : 'OFF')
    }
}
