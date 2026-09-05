import HADevice from './base'
import AABBDevice from './aabb_device'
import { type ComponentInfo, type Connection } from '../homeassistant'
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
// Offsets were established from labelled power/door and full-cycle captures and checked against FX___N
// ModelJSON. Power and the cycle-setting controls below reproduce frames captured from the official
// ThinQ app. Start and pause remain intentionally unavailable. Laundry care is exposed only after a
// completed cycle while the appliance still reports remote control as enabled.

const HEADER_LENGTH = 13
const COMPACT_HEADER_LENGTH = 9
const SETTINGS_RESPONSE_HEADER_LENGTH = 23
const STATE_BLOCK_LENGTH = 67
const RESYNC_TYPE = 0x55
const UPDATE_TYPE = 0x98
const COMPACT_TYPE = 0xe6
const DOOR_TYPE = 0x18
const DOOR_OFFSET = 18

type LocalOption = { code: number; en: string; ko: string; writable?: false }
type CycleSetting = 'soil' | 'rinse' | 'spin' | 'temperature' | 'turbo' | 'reserve'
type PendingSettings = {
    course?: number
    soil?: number
    rinse?: number
    spin?: number
    temperature?: number
    turbo?: number
    reserve?: number
}

const COURSE_OPTIONS: LocalOption[] = [
    { code: 0x08, en: 'Baby Care', ko: '아기옷' },
    { code: 0x1b, en: 'Duvet', ko: '이불' },
    { code: 0x2e, en: 'Normal', ko: '표준' },
    { code: 0x37, en: 'Rinse + Spin', ko: '헹굼+탈수' },
    { code: 0x4a, en: 'Speed Wash', ko: '소량급속' },
    { code: 0x4c, en: 'Speed Boil', ko: '알뜰삶음' },
    { code: 0x4e, en: 'Spin Only', ko: '탈수 단독' },
    { code: 0x55, en: 'Tub Clean', ko: '통살균' },
    { code: 0x5e, en: 'Wool', ko: '울/섬세' },
    { code: 0x72, en: 'AI Wash', ko: '인공지능 세탁' },
    { code: 0x88, en: 'Microplastic Care', ko: '미세플라스틱 케어' },
]

// Only values reproduced through the official app are offered as writable options. Some additional
// raw state values exist (for example Soaking), but they were not sent in a labelled capture and
// therefore stay read-only.
const SOIL_OPTIONS: LocalOption[] = [
    { code: 0x00, en: 'No wash', ko: '세탁 안 함', writable: false },
    { code: 0x01, en: 'Light', ko: '적은때' },
    { code: 0x03, en: 'Normal', ko: '표준' },
    { code: 0x05, en: 'Heavy', ko: '강력' },
    { code: 0x06, en: 'Pre-wash', ko: '애벌세탁' },
    { code: 0x07, en: 'Soaking', ko: '불림', writable: false },
]
const RINSE_OPTIONS: LocalOption[] = [
    { code: 0x00, en: 'No rinse', ko: '헹굼 안 함', writable: false },
    { code: 0x01, en: '1 rinse', ko: '1회' },
    { code: 0x02, en: '2 rinses', ko: '2회' },
    { code: 0x03, en: '3 rinses', ko: '3회' },
    { code: 0x04, en: '4 rinses', ko: '4회', writable: false },
    { code: 0x05, en: '5 rinses', ko: '5회', writable: false },
]
const SPIN_OPTIONS: LocalOption[] = [
    { code: 0x00, en: 'Off', ko: '꺼짐' },
    { code: 0x01, en: 'Delicate', ko: '섬세' },
    { code: 0x02, en: 'Low', ko: '약' },
    { code: 0x04, en: 'Medium', ko: '중' },
    { code: 0x06, en: 'High', ko: '강' },
    { code: 0x08, en: 'Dry matching', ko: '건조 맞춤' },
]
const TEMPERATURE_OPTIONS: LocalOption[] = [
    { code: 0x00, en: 'No temperature', ko: '물온도 없음', writable: false },
    { code: 0x08, en: 'Cold', ko: '냉수' },
    { code: 0x02, en: '30 °C', ko: '30℃' },
    { code: 0x03, en: '40 °C', ko: '40℃' },
    { code: 0x05, en: '60 °C', ko: '60℃' },
    { code: 0x06, en: '95 °C', ko: '95℃', writable: false },
]
const TURBO_OPTIONS: LocalOption[] = [
    { code: 0x00, en: 'Off', ko: '꺼짐' },
    { code: 0x01, en: 'On', ko: '켜짐' },
]
const RESERVE_OPTIONS: LocalOption[] = [
    { code: 0, en: 'Off', ko: '예약 안 함' },
    ...Array.from({ length: 33 }, (_, index) => {
        const minutes = 180 + index * 30
        const hours = Math.floor(minutes / 60)
        const remainingMinutes = minutes % 60
        return {
            code: minutes,
            en: remainingMinutes === 0 ? `Finish in ${hours} hours` : `Finish in ${hours} hours 30 minutes`,
            ko: remainingMinutes === 0 ? `${hours}시간 뒤 완료` : `${hours}시간 30분 뒤 완료`,
        }
    }),
]

const SETTING_OPTIONS: Record<CycleSetting, LocalOption[]> = {
    soil: SOIL_OPTIONS,
    rinse: RINSE_OPTIONS,
    spin: SPIN_OPTIONS,
    temperature: TEMPERATURE_OPTIONS,
    turbo: TURBO_OPTIONS,
    reserve: RESERVE_OPTIONS,
}

const CONTROL_PROPERTY: Record<CycleSetting, string> = {
    soil: 'soil_control',
    rinse: 'rinse_control',
    spin: 'spin_control',
    temperature: 'temperature_control',
    turbo: 'turbo_wash_control',
    reserve: 'reserve_time_control',
}
const CYCLE_SETTINGS = Object.keys(CONTROL_PROPERTY) as CycleSetting[]
const COURSE_CONTROL_OPTIONS: ReadonlyArray<readonly [property: string, options: LocalOption[]]> = [
    ['course_control', COURSE_OPTIONS],
    ...CYCLE_SETTINGS.map((setting) => [CONTROL_PROPERTY[setting], SETTING_OPTIONS[setting]] as const),
]

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
    private readonly korean: boolean
    private currentState = 0
    private remoteStartEnabled = false
    private actual: PendingSettings = {}
    private pending: PendingSettings = {}
    private readonly reportedControlLabels: Record<string, string> = {}

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        const korean = meta.countryCode === 'KR' || meta.subCountryCode === 'KR'
        this.korean = korean
        const name = (english: string, koreanName: string) => (korean ? koreanName : english)
        const options = (items: LocalOption[]) => items.map((item) => (korean ? item.ko : item.en))
        // MQTT discovery does not expose Home Assistant integration translation keys, so names and
        // options use the locale reported by the appliance registration metadata.
        // Platform-only entries remove obsolete components and refresh existing entities whose
        // Home Assistant registry metadata changed. The final discovery payload restores refreshed
        // entities with the same unique_id, so their entity_id and automations remain compatible.
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: name('LG FX25 Washer', 'LG FX25 세탁기') }),
                components: {
                    power_control: {
                        platform: 'switch',
                        unique_id: '$deviceid-power-control',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: name('Power', '전원'),
                        optimistic: false,
                        icon: 'mdi:power',
                    },
                    laundry_care_start: {
                        platform: 'button',
                        unique_id: '$deviceid-laundry-care-start',
                        command_topic: '$this/laundry_care_start/set',
                        name: name('Start laundry care', '세탁물 케어 시작'),
                        icon: 'mdi:tshirt-crew-outline',
                        availability: [
                            { topic: '$this/availability' },
                            { topic: '$rethink/availability' },
                            {
                                topic: '$this/laundry_care_available',
                                payload_available: 'ON',
                                payload_not_available: 'OFF',
                            },
                        ],
                        availability_mode: 'all',
                    },
                    course_control: {
                        platform: 'select',
                        unique_id: '$deviceid-course-control',
                        state_topic: '$this/course_control',
                        command_topic: '$this/course_control/set',
                        name: name('Program', '코스'),
                        options: options(COURSE_OPTIONS),
                        optimistic: false,
                        icon: 'mdi:playlist-edit',
                    },
                    soil_control: {
                        platform: 'select',
                        unique_id: '$deviceid-soil-control',
                        state_topic: '$this/soil_control',
                        command_topic: '$this/soil_control/set',
                        name: name('Soil level', '오염도'),
                        options: options(SOIL_OPTIONS),
                        optimistic: false,
                        icon: 'mdi:liquid-spot',
                    },
                    rinse_control: {
                        platform: 'select',
                        unique_id: '$deviceid-rinse-control',
                        state_topic: '$this/rinse_control',
                        command_topic: '$this/rinse_control/set',
                        name: name('Rinse count', '헹굼 횟수'),
                        options: options(RINSE_OPTIONS),
                        optimistic: false,
                        icon: 'mdi:water-sync',
                    },
                    spin_control: {
                        platform: 'select',
                        unique_id: '$deviceid-spin-control',
                        state_topic: '$this/spin_control',
                        command_topic: '$this/spin_control/set',
                        name: name('Spin level', '탈수 세기'),
                        options: options(SPIN_OPTIONS),
                        optimistic: false,
                        icon: 'mdi:rotate-right',
                    },
                    temperature_control: {
                        platform: 'select',
                        unique_id: '$deviceid-temperature-control',
                        state_topic: '$this/temperature_control',
                        command_topic: '$this/temperature_control/set',
                        name: name('Wash temperature', '세탁 온도'),
                        options: options(TEMPERATURE_OPTIONS),
                        optimistic: false,
                        icon: 'mdi:thermometer',
                    },
                    turbo_wash_control: {
                        platform: 'select',
                        unique_id: '$deviceid-turbo-wash-control',
                        state_topic: '$this/turbo_wash_control',
                        command_topic: '$this/turbo_wash_control/set',
                        name: name('TurboWash', '터보샷'),
                        options: options(TURBO_OPTIONS),
                        optimistic: false,
                        icon: 'mdi:rocket-launch',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: name('Current status', '현재 상태'),
                        icon: 'mdi:state-machine',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining-time',
                        state_topic: '$this/remaining_time',
                        name: name('Remaining time', '남은 시간'),
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        icon: 'mdi:timer-outline',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial-time',
                        state_topic: '$this/initial_time',
                        name: name('Initial time', '전체 시간'),
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        icon: 'mdi:timer-sand',
                    },
                    reserve_time_control: {
                        platform: 'select',
                        unique_id: '$deviceid-reserve-time-control',
                        state_topic: '$this/reserve_time_control',
                        command_topic: '$this/reserve_time_control/set',
                        name: name('Reserved completion', '예약 완료'),
                        options: options(RESERVE_OPTIONS),
                        optimistic: false,
                        icon: 'mdi:clock-outline',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: name('Door', '문'),
                        device_class: 'door',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door-lock',
                        state_topic: '$this/door_lock',
                        name: name('Door lock', '문 잠금'),
                        icon: 'mdi:lock',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child-lock',
                        state_topic: '$this/child_lock',
                        name: name('Child lock', '버튼 잠금'),
                        icon: 'mdi:account-lock',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote-start',
                        state_topic: '$this/remote_start',
                        name: name('Remote start', '원격 제어'),
                        icon: 'mdi:remote',
                    },
                    crease_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-crease-care',
                        state_topic: '$this/crease_care',
                        name: name('Crease care', '구김방지'),
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub-clean-count',
                        state_topic: '$this/tub_clean_count',
                        // FX___N calls this TCLCount, while LG's official HA integration exposes
                        // the same counter as "Use count". A complete real cycle incremented both
                        // views from 12 to 13 at the same instant.
                        name: name('Use count', '사용 횟수'),
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                    },
                    error: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: name('Error', '오류'),
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    },
                },
            }),
            {
                course: { platform: 'sensor' },
                soil: { platform: 'sensor' },
                rinse: { platform: 'sensor' },
                spin: { platform: 'sensor' },
                temperature: { platform: 'sensor' },
                turbo_wash: { platform: 'binary_sensor' },
                apply_cycle_settings: { platform: 'button' },
                pre_wash: { platform: 'binary_sensor' },
                steam: { platform: 'binary_sensor' },
                reserve_time: { platform: 'sensor' },
                power: { platform: 'binary_sensor' },
            },
            {
                // entity_category is stored in HA's entity registry and is not migrated by an
                // in-place MQTT discovery update. Re-register these two existing components so
                // Door lock moves to Sensors and Use count moves to Diagnostic.
                door_lock: { platform: 'binary_sensor' },
                tub_clean_count: { platform: 'sensor' },
            },
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
        // A cycle-settings write first receives a tiny generic ACK, followed about one second later
        // by this extended E6 response. Its eight echoed setting pairs are followed by a complete
        // authoritative state block, so no polling is needed while waiting for the later 0x98 update.
        if (
            buf[1] === COMPACT_TYPE &&
            buf.length === SETTINGS_RESPONSE_HEADER_LENGTH + STATE_BLOCK_LENGTH &&
            buf[4] === 0x01 &&
            buf[5] === 0xff &&
            buf[6] === 0x08 &&
            buf[7] === 0x1e &&
            buf[9] === 0x20 &&
            buf[11] === 0x21 &&
            buf[13] === 0x1f &&
            buf[15] === 0x35 &&
            buf[17] === 0x3e &&
            buf[19] === 0x43 &&
            buf[21] === 0x7f
        ) {
            return this.processStateBlock(
                buf.subarray(SETTINGS_RESPONSE_HEADER_LENGTH, SETTINGS_RESPONSE_HEADER_LENGTH + STATE_BLOCK_LENGTH),
            )
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

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            // Captured twice in each direction from the official ThinQ app. The final
            // byte is the requested state; AABBDevice supplies the outer checksum.
            if (mqttValue === 'ON') this.send(Buffer.from('F0E5000201FF010201', 'hex'))
            else if (mqttValue === 'OFF') this.send(Buffer.from('F0E5000201FF010200', 'hex'))
            return
        }

        if (prop === 'course_control') {
            if (this.currentState !== 0x01) return
            const code = this.codeFor(COURSE_OPTIONS, mqttValue)
            if (code === undefined) return
            this.pending.course = code
            return this.send(Buffer.from([0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff, 0x01, 0x0a, code]))
        }

        if (prop === 'laundry_care_start') {
            // Captured from the official ThinQ app at the real post-cycle Complete state. Sending
            // 0x57 outside this narrow state can alter cycle options or start an unintended cycle,
            // so do not forward the button unless both appliance-reported guards are satisfied.
            if (mqttValue !== 'PRESS' || this.currentState !== 0x2a || !this.remoteStartEnabled) return
            return this.send(Buffer.from('F0E5000201FF015701', 'hex'))
        }

        const setting = CYCLE_SETTINGS.find((candidate) => CONTROL_PROPERTY[candidate] === prop)
        if (setting !== undefined) {
            if (this.currentState !== 0x01) return
            const code = this.codeFor(SETTING_OPTIONS[setting], mqttValue)
            if (code === undefined) return
            this.pending[setting] = code
            return this.sendSettings({ ...this.actual, ...this.pending })
        }
    }

    private labelFor(options: LocalOption[], code: number): string | undefined {
        const item = options.find((candidate) => candidate.code === code)
        return item === undefined ? undefined : this.korean ? item.ko : item.en
    }

    private codeFor(options: LocalOption[], label: string): number | undefined {
        return options.find((item) => item.writable !== false && (this.korean ? item.ko : item.en) === label)?.code
    }

    private rememberActualSetting(setting: CycleSetting, code: number): string | undefined {
        const label = this.labelFor(SETTING_OPTIONS[setting], code)
        if (label !== undefined) {
            this.reportedControlLabels[CONTROL_PROPERTY[setting]] = label
        }
        return label
    }

    private publishActualSetting(setting: CycleSetting, code: number) {
        const label = this.rememberActualSetting(setting, code)
        if (label !== undefined) this.publishProperty(CONTROL_PROPERTY[setting], label)
    }

    private updateCourseControlOptions(editable: boolean) {
        if (this.config === undefined) return

        let changed = false
        const components = { ...this.config.components } as Record<string, ComponentInfo & Record<string, unknown>>
        for (const [property, optionDefinitions] of COURSE_CONTROL_OPTIONS) {
            const component = components[property]
            if (component === undefined) continue
            const desired = editable
                ? optionDefinitions.map((option) => (this.korean ? option.ko : option.en))
                : this.reportedControlLabels[property] === undefined
                  ? []
                  : [this.reportedControlLabels[property]]
            const current = component.options as string[]
            if (current.length === desired.length && current.every((option, index) => option === desired[index]))
                continue
            components[property] = { ...component, options: desired }
            changed = true
        }

        if (!changed) return
        this.config = { ...this.config, components }
        this.publishConfig()
    }

    private sendSettings(settings: PendingSettings) {
        if (
            ![
                settings.soil,
                settings.rinse,
                settings.spin,
                settings.temperature,
                settings.turbo,
                settings.reserve,
            ].every((value) => value !== undefined)
        )
            return

        const { soil, rinse, spin, temperature, turbo, reserve } = settings
        this.send(
            Buffer.from([
                0xf0,
                0xe5,
                0x00,
                0x02,
                0x01,
                0xff,
                0x08,
                0x1e,
                soil!,
                0x20,
                rinse!,
                0x21,
                spin!,
                0x1f,
                temperature!,
                0x35,
                turbo!,
                0x3e,
                0x00,
                0x43,
                0x00,
                0x7f,
                (reserve! >> 8) & 0xff,
                reserve! & 0xff,
            ]),
        )
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
        this.currentState = state
        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[state] ?? 'Running')
        this.publishProperty('remaining_time', isOff ? 0 : minutes(block, 13))
        this.publishProperty('initial_time', isOff ? 0 : minutes(block, 15))
        const reserve = isOff ? 0 : minutes(block, 11)
        // The control select only updates for values the app can configure (0 or 3h..19h in
        // 30-minute steps), so a live 179-minute countdown does not replace its last confirmed
        // "Finish in 3 hours" selection.
        if (isOff) this.rememberActualSetting('reserve', 0)
        this.publishProperty('error', ERROR[block[19]] ?? `Unknown (${block[19]})`)
        this.publishProperty('tub_clean_count', block[28])

        const turbo = (block[34] & 0x20) !== 0 ? 1 : 0
        this.publishProperty('crease_care', (block[36] & 0x80) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (block[37] & 0x20) !== 0 ? 'ON' : 'OFF')
        this.remoteStartEnabled = (block[37] & 0x10) !== 0
        this.publishProperty('remote_start', this.remoteStartEnabled ? 'ON' : 'OFF')
        this.publishProperty('laundry_care_available', state === 0x2a && this.remoteStartEnabled ? 'ON' : 'OFF')
        this.publishProperty('door_lock', (block[38] & 0x01) !== 0 ? 'ON' : 'OFF')

        // Powered-off blocks contain sentinels and a mixture of retained settings, so they must not
        // replace pending controls. A powered-on state frame is the appliance's authoritative state.
        if (isOff) {
            this.updateCourseControlOptions(false)
            this.publishActualSetting('reserve', 0)
            return
        }

        this.actual = {
            course: block[5],
            soil: block[1],
            temperature: block[2],
            rinse: block[3],
            spin: block[4],
            turbo,
            reserve,
        }
        this.pending = {}

        const course = this.labelFor(COURSE_OPTIONS, this.actual.course!)
        if (course !== undefined) this.reportedControlLabels.course_control = course
        for (const setting of CYCLE_SETTINGS) this.rememberActualSetting(setting, this.actual[setting]!)
        // Update a narrowed option list before publishing any newly reported value, otherwise Home
        // Assistant can briefly reject a value that was not part of the preceding one-item list.
        this.updateCourseControlOptions(state === 0x01)
        if (course !== undefined) this.publishProperty('course_control', course)
        for (const setting of CYCLE_SETTINGS) this.publishActualSetting(setting, this.actual[setting]!)
    }
}
