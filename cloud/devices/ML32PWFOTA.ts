import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

const STATUS: Record<number, [string, string]> = {
    0x00: ['Idle', '대기'],
    0x02: ['Cooking', '조리'],
    0x04: ['Paused', '일시정지'],
    0x05: ['Complete', '완료'],
    0x07: ['Setting', '설정'],
}

export default class Device extends AABBDevice {
    private readonly korean: boolean

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
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining-time',
                        state_topic: '$this/remaining_time',
                        name: name('Remaining time', '남은 시간'),
                        device_class: 'duration',
                        unit_of_measurement: 's',
                        icon: 'mdi:timer-outline',
                    },
                    cooking: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cooking',
                        state_topic: '$this/cooking',
                        name: name('Cooking', '조리 중'),
                        device_class: 'running',
                        icon: 'mdi:toaster-oven',
                    },
                },
            }),
        )
    }

    private processRecord(record: Buffer) {
        const state = record[0]
        const status = STATUS[state]
        this.publishProperty('status', status ? status[this.korean ? 1 : 0] : `Code ${state}`)
        this.publishProperty('remaining_time', record[3] * 3600 + record[4] * 60 + record[5])
        this.publishProperty('cooking', state === 0x02 ? 'ON' : 'OFF')
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x40) return

        if (buf[1] === 0xec && buf.length === 58) {
            this.processRecord(buf.subarray(30, 58))
        } else if (buf[1] === 0xeb && buf.length === 30) {
            this.processRecord(buf.subarray(2, 30))
        } else if (buf[1] === 0x72 && buf.length >= 5 && buf[3] === 0x04 && buf[4] === 0x0a) {
            const complete = STATUS[0x05]
            this.publishProperty('status', complete[this.korean ? 1 : 0])
            this.publishProperty('remaining_time', 0)
            this.publishProperty('cooking', 'OFF')
        }
    }
}
