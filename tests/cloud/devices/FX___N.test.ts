import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/FX___N'
import { MockHAConnection, MockThinq2Device, buf } from '../../helpers/mocks'
import type { Metadata } from '@/cloud/thinq'

const DEVICE_ID = 'fx25-device'
const META: Metadata = { modelId: 'FX___N', modelName: 'FX___N', swVersion: '2.11.296', deviceType: '201' }
const KOREAN_META: Metadata = { ...META, modelLanguage: '01', countryCode: 'KR', subCountryCode: 'KR' }

// Real frames from the labelled FX25 capture: powered off resync, power-on update, power-off update,
// and door close/open events. Extended frames use 0xff in the AABB length slot; AABBDevice intentionally
// does not validate that legacy single-byte length field.
const OFF_RESYNC = buf(
    'AAFF200A0055002228000100EB004300030300062E00000000000000000100000000002E000105000000000C0400000000200000000000380000000000000400000000000000000000000000000018000000F019BB',
)
const POWER_ON = buf(
    'AAFF200A0098002290000100EC008600030300062E00000000000000000100000000002E000105000000000C040000000020000000000038000000000000040000000000000000000000000000001800000000030302062E00000000000000002300230000002E01000500000002000400000000200000000000380000000000000400000000000000000000000000000018000000DFE6BB',
)
const POWER_OFF = buf(
    'AAFF200A009800229D000100EC008600030302062E00000000000000002300230000002E010005000000020C040000000020000000000038000000000000040000000000000000000000000000001800000000030300062E00000000000000000100000000002E000105000000000C040000000020000000000038000000000000040000000000000000000000000000001800000028F8BB',
)
const COMPACT_POWER_ON = buf(
    'AA5020E6000001FF01020000030302062E00000000000000002300230000002E010005000000020C04000000002000000000003800000000000004000000000000000000000000000000180000006ABB',
)
const COMPACT_POWER_OFF = buf(
    'AA5020E6000001FF01020000030300062E00000000000000000100000000002E000105000000000C0400000000200000000000380000000000000400000000000000000000000000000018000000A3BB',
)
const DOOR_CLOSED = buf('AAFF200A0018002283000101030006100B0B0110029536BB')
const DOOR_OPEN = buf('AAFF200A0018002285000101030006100B0B0110012A3EBB')
const CYCLE_WASHING = buf(
    'aaff200a0098007aba000100ec008600030202062e00000000000000002700270000002e030105000000020c04000000002000009001003c000000000000040000000000000000000000000000001800000000030202062e00000000000000005400540000002e0b0305040000020c04000000002000009001003c00000000000004000000000000000000000000000000180000003b15bb',
)
const CYCLE_RINSING = buf(
    'aaff200a0098007c78000100ec008600030202062e00000000000000003300540035002e0b0305040000020c04000000002000009001003c000000000000040000000000000000000000000000001800000000000002062e00000000000000003200540037002e0c0b05040000020c04000000002000009001003c00000000000004000000000000000000000000000000180000009181bb',
)
const CYCLE_SPINNING = buf(
    'aaff200a0098007e64000100ec008600000001062e0000000000000000140054006d002e0c0b05040000010c04000000002000009001003c000000000000040000000000000000000000000000001800000000000000062e0000000000000000130054006d002e0e0c05040000000c04000000002000009001003c0000000000000400000000000000000000000000000018000000761ebb',
)
const CYCLE_COMPLETE = buf(
    'aaff200a0098007f93000100ec008600000000062e0000000000000000010054008f002e0e0c05040000000c04000000002000009001003c000000000000040000000000000000000000000000001800000000000000002e00000000000000000100540090002e2a0e05040000000d04000000000000001001003c0000000000000400000000000000000000000000000018000000dbe6bb',
)
const CYCLE_LAUNDRY_CARE = buf(
    'aa5020e6000201ff01570000000000002e00000000000000000100540091002e2f2a05040000000d04000000000000001001003c0000000000000c00000000000000000000000000000018000000d5bb',
)

function makeDevice(meta: Metadata = META) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, meta)
    const dev = new DUT(ha.asConnection(), thinq, meta)
    return { ha, thinq, dev }
}

describe('FX___N', () => {
    test('publishes read-only status entities plus the isolated power control', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const id of [
            'power',
            'status',
            'course',
            'remaining_time',
            'initial_time',
            'reserve_time',
            'soil',
            'rinse',
            'spin',
            'temperature',
            'door',
            'door_lock',
            'child_lock',
            'remote_start',
            'turbo_wash',
            'pre_wash',
            'steam',
            'crease_care',
            'tub_clean_count',
            'error',
        ]) {
            assert.ok(components[id], `${id} component present`)
            assert.equal(components[id].command_topic, undefined, `${id} remains read-only`)
        }
        assert.equal(components.power_control.platform, 'switch')
        assert.equal(components.power_control.state_topic, '$this/power')
        assert.equal(components.power_control.command_topic, '$this/power/set')
        for (const id of [
            'course',
            'soil',
            'rinse',
            'spin',
            'temperature',
            'turbo_wash',
            'pre_wash',
            'steam',
            'crease_care',
        ]) {
            assert.match(components[id].name as string, /^Wash setting · /, `${id} sorts with cycle settings`)
            assert.equal(components[id].entity_category, undefined, `${id} remains in the Sensor section`)
        }
        for (const [id, component] of Object.entries(components)) {
            if (component.platform !== 'sensor' && component.platform !== 'binary_sensor') continue
            assert.notEqual(component.entity_category, 'config', `${id} must use an MQTT-supported entity category`)
        }
        assert.equal(components.tub_clean_count.name, 'Use count')
        assert.equal(components.tub_clean_count.entity_category, undefined)
        assert.equal(components.door_lock.entity_category, 'diagnostic')
    })

    test('uses LG Korean display names for a KR device without changing discovery identity or topics', () => {
        const { ha } = makeDevice(KOREAN_META)
        const config = ha.devices[DEVICE_ID].config!
        const components = config.components as Record<string, Record<string, unknown>>
        assert.equal(config.device.name, 'LG FX25 세탁기')
        assert.deepEqual(
            Object.fromEntries(
                [
                    'course',
                    'soil',
                    'rinse',
                    'spin',
                    'temperature',
                    'turbo_wash',
                    'pre_wash',
                    'steam',
                    'crease_care',
                ].map((id) => [id, components[id].name]),
            ),
            {
                course: '세탁 설정 · 세탁 코스',
                soil: '세탁 설정 · 오염도',
                rinse: '세탁 설정 · 헹굼 횟수',
                spin: '세탁 설정 · 탈수 세기',
                temperature: '세탁 설정 · 물 온도',
                turbo_wash: '세탁 설정 · 터보샷',
                pre_wash: '세탁 설정 · 애벌세탁',
                steam: '세탁 설정 · 스팀',
                crease_care: '세탁 설정 · 구김방지',
            },
        )
        assert.equal(components.power.name, '전원')
        assert.equal(components.power_control.name, '전원 제어')
        assert.equal(components.status.name, '현재 상태')
        assert.equal(components.remaining_time.name, '남은 시간')
        assert.equal(components.door.name, '문')
        assert.equal(components.tub_clean_count.name, '사용 횟수')
        assert.equal(components.error.name, '오류')
        assert.equal(components.course.unique_id, '$deviceid-course')
        assert.equal(components.course.state_topic, '$this/course')
        assert.equal(components.course.command_topic, undefined)
    })

    test('HA power writes reproduce both official ThinQ command frames byte-for-byte', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('power', 'ON')
        dev.setProperty('power', 'OFF')

        assert.deepEqual(thinq.outbox, [buf('AA0DF0E5000201FF010201C7BB'), buf('AA0DF0E5000201FF010200C4BB')])
    })

    test('power control rejects unknown values and does not expose other writes', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('power', 'TOGGLE')
        dev.setProperty('course', 'Speed Wash')
        dev.setProperty('start', 'PRESS')

        assert.deepEqual(thinq.outbox, [])
    })

    test('real 0x55 resync decodes the powered-off state without a stale countdown', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', OFF_RESYNC)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.course, 'Normal')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.error, 'No error')
        assert.equal(p.tub_clean_count, 12)
    })

    test('real 0x98 update reads the second block as current and decodes selected settings', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', POWER_ON)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Initial')
        assert.equal(p.course, 'Normal')
        assert.equal(p.remaining_time, 35)
        assert.equal(p.initial_time, 35)
        assert.equal(p.soil, 'Normal')
        assert.equal(p.rinse, 3)
        assert.equal(p.temperature, 30)
        assert.equal(p.spin, 1000)
        assert.equal(p.turbo_wash, 'ON')
    })

    test('real power-off update clears the countdown and uses the current block', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', POWER_ON)
        thinq.emit('data', POWER_OFF)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.tub_clean_count, 12)
    })

    test('real compact 0xE6 snapshots correct retained state on power-on and power-off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COMPACT_POWER_ON)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Initial')
        assert.equal(p.remaining_time, 35)
        assert.equal(p.initial_time, 35)
        assert.equal(p.course, 'Normal')

        thinq.emit('data', COMPACT_POWER_OFF)
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.tub_clean_count, 12)
    })

    test('real 0x18 events decode door close and open', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
        thinq.emit('data', DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
    })

    test('real full-cycle frames follow washing through laundry care', () => {
        const { ha, thinq } = makeDevice()
        const expected: Array<[Buffer, string, number, number]> = [
            [CYCLE_WASHING, 'Washing', 84, 12],
            [CYCLE_RINSING, 'Rinsing', 50, 12],
            [CYCLE_SPINNING, 'Spinning', 19, 12],
            [CYCLE_COMPLETE, 'Complete', 1, 13],
            [CYCLE_LAUNDRY_CARE, 'Laundry care', 1, 13],
        ]

        for (const [frame, status, remaining, useCount] of expected) {
            thinq.emit('data', frame)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.status, status)
            assert.equal(p.remaining_time, remaining)
            assert.equal(p.tub_clean_count, useCount)
        }
    })

    test('unknown door values and malformed state frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DOOR_OPEN)
        thinq.emit('data', buf('AAFF200A0018002285000101030006110B0B0111050D00BB'))
        thinq.emit('data', buf('AA10200A0055000000000000430000BB'))
        const wrongSubtype = Buffer.from(OFF_RESYNC)
        wrongSubtype[12] = 0xea // full[12] = inner[10], must be the captured 0xEB state subtype
        thinq.emit('data', wrongSubtype)
        const wrongCompactPrefix = Buffer.from(COMPACT_POWER_OFF)
        wrongCompactPrefix[8] = 0x02 // full[8] = inner[6], captured compact prefix requires 0x01
        thinq.emit('data', wrongCompactPrefix)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })
})
