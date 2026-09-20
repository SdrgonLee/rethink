import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

type Localized = [english: string, korean: string]

const STATUS: Record<number, Localized> = {
    0x00: ['Idle', '대기'],
    0x01: ['Preheating', '예열 중'],
    0x02: ['Cooking', '조리 중'],
    0x03: ['Cleaning', '청소 중'],
    0x04: ['Paused', '일시정지'],
    0x05: ['Complete', '완료'],
    0x06: ['Preheating complete', '예열 완료'],
    0x07: ['Setting', '설정'],
}

const PROGRAM: Record<number, Localized> = {
    0x01: ['Microwave', '레인지'],
    0x02: ['Steam microwave', '스팀레인지'],
    0x03: ['Grill', '구이'],
    0x04: ['Oven', '오븐'],
    0x05: ['Steam oven', '스팀오븐'],
    0x06: ['Steam', '스팀'],
    0x07: ['Dehydrate', '식품건조'],
    0x15: ['Ferment', '발효'],
    0x16: ['Steam ferment', '스팀발효'],
}

const CLEANING: Record<number, Localized> = {
    0x01: ['Steam deodorize', '스팀청소탈취'],
    0x02: ['Steam clean', '스팀청소'],
    0x03: ['Cavity dry', '조리실건조'],
    0x04: ['Drain residual water', '잔수제거'],
    0x05: ['Steam generator clean', '스팀발생기세정'],
}

const RUNNING_STATES = new Set([0x02, 0x03])
const ACTIVE_STATES = new Set([0x01, 0x02, 0x03, 0x04, 0x06])
const TOTAL_START_STATES = new Set([0x00, 0x01, 0x05, 0x06, 0x07])
const MY_RECIPE_MARKER = 0x13

function hex(value: number) {
    return `0x${value.toString(16).padStart(2, '0').toUpperCase()}`
}

export default class Device extends AABBDevice {
    private readonly korean: boolean
    private cycleActive = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.korean = meta.countryCode === 'KR' || meta.subCountryCode === 'KR'
        const name = (english: string, korean: string) => (this.korean ? korean : english)

        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: name('LG Lightwave Oven', 'LG 광파오븐') }),
                components: {
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: name('Status', '상태'),
                        icon: 'mdi:state-machine',
                    },
                    active_program: {
                        platform: 'sensor',
                        unique_id: '$deviceid-active-program',
                        state_topic: '$this/active_program',
                        name: name('Active program', '현재 코스'),
                        icon: 'mdi:toaster-oven',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining-time',
                        state_topic: '$this/remaining_time',
                        name: name('Remaining time', '남은 시간'),
                        device_class: 'duration',
                        unit_of_measurement: 's',
                        icon: 'mdi:timer-outline',
                    },
                    target_temperature: {
                        platform: 'sensor',
                        unique_id: '$deviceid-target-temperature',
                        state_topic: '$this/target_temperature',
                        name: name('Target temperature', '목표 온도'),
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        icon: 'mdi:thermometer',
                    },
                    total_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-total-time',
                        state_topic: '$this/total_time',
                        name: name('Total time', '총 시간'),
                        device_class: 'duration',
                        unit_of_measurement: 's',
                        icon: 'mdi:timer-sand',
                    },
                },
            }),
            { cooking: { platform: 'binary_sensor' } },
        )
    }

    private localize(value: Localized) {
        return value[this.korean ? 1 : 0]
    }

    private unknown(label: string) {
        return `${this.korean ? '알 수 없는' : 'Unknown'} ${label}`
    }

    private decodeProgram(record: Buffer) {
        const state = record[0]
        const id = record[1]
        const subId = record[2]

        if (!ACTIVE_STATES.has(state)) return this.korean ? '알 수 없음' : 'Unknown'
        if (id === 0) return this.korean ? '알 수 없음' : 'Unknown'

        if (state === 0x03 || (state === 0x04 && id === 0x12)) {
            if (id !== 0x12) return `${this.unknown(this.korean ? '청소 기능' : 'cleaning function')} (${hex(id)})`
            const cleaning = CLEANING[subId]
            return cleaning
                ? this.localize(cleaning)
                : `${this.unknown(this.korean ? '청소 기능' : 'cleaning function')} (${hex(subId)})`
        }

        if (id === 0x12) return `${this.unknown(this.korean ? '코스' : 'program')} (${hex(id)}/${hex(subId)})`
        if (id === MY_RECIPE_MARKER) return this.korean ? '내가 만든 레시피' : 'My recipe'

        const program = PROGRAM[id]
        return program ? this.localize(program) : `${this.unknown(this.korean ? '코스' : 'program')} (${hex(id)})`
    }

    private processRecord(record: Buffer, previousState?: number) {
        if (record.length !== 28) return

        const state = record[0]
        const status = STATUS[state]
        const remaining = record[3] * 3600 + record[4] * 60 + record[5]

        this.publishProperty(
            'status',
            status ? this.localize(status) : `${this.unknown(this.korean ? '상태' : 'status')} (${hex(state)})`,
        )
        this.publishProperty('active_program', this.decodeProgram(record))

        if (state === 0x02 || state === 0x03 || state === 0x04) this.publishProperty('remaining_time', remaining)
        else this.publishProperty('remaining_time', 'None')

        if (ACTIVE_STATES.has(state) && (PROGRAM[record[1]] || record[1] === MY_RECIPE_MARKER) && record[6] !== 0)
            this.publishProperty('target_temperature', record[6])
        else this.publishProperty('target_temperature', 'None')

        if (RUNNING_STATES.has(state)) {
            if (!this.cycleActive) {
                this.publishProperty(
                    'total_time',
                    previousState !== undefined && TOTAL_START_STATES.has(previousState) ? remaining : 'None',
                )
                this.cycleActive = true
            }
        } else if (state === 0x04) {
            if (!this.cycleActive) this.publishProperty('total_time', 'None')
        } else {
            this.cycleActive = false
            this.publishProperty('total_time', 'None')
        }
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x40) return

        if (buf[1] === 0xec && buf.length === 58) {
            this.processRecord(buf.subarray(30, 58), buf[2])
        } else if (buf[1] === 0xeb && buf.length === 30) {
            this.processRecord(buf.subarray(2, 30))
        }
    }
}
