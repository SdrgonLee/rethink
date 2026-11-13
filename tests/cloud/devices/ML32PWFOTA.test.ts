import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/ML32PWFOTA'
import type { ComponentInfo } from '@/cloud/homeassistant'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-oven'
const META: Metadata = {
    modelId: 'ML32PWFOTA',
    modelName: 'ML32PWFOTA',
    swVersion: '1.0',
    countryCode: 'KR',
}

function packet(inner: Buffer): Buffer {
    const result = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0, 0xbb])])
    result[result.length - 2] = (result.subarray(0, -2).reduce((sum, value) => sum + value, 0) & 0xff) ^ 0x55
    return result
}

function record(state: number, id = 0, subId = 0, hour = 0, minute = 0, second = 0, temperature = 0) {
    const result = Buffer.alloc(28)
    result[0] = state
    result[1] = id
    result[2] = subId
    result[3] = hour
    result[4] = minute
    result[5] = second
    result[6] = temperature
    return result
}

function statePacket(current: Buffer, previous = Buffer.alloc(28)) {
    return packet(Buffer.concat([Buffer.from([0x40, 0xec]), previous, current]))
}

function reconnectPacket(current: Buffer) {
    return packet(Buffer.concat([Buffer.from([0x40, 0xeb]), current]))
}

function makeDevice(meta = META) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, meta)
    const dev = new DUT(ha.asConnection(), thinq, meta)
    return { ha, thinq, dev }
}

describe('ML32PWFOTA', () => {
    test('queries status immediately and every 30 seconds until dropped', (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] })
        const { thinq, dev } = makeDevice()

        dev.start()
        assert.deepEqual(
            thinq.outbox.map((packet) => packet.toString('hex').toUpperCase()),
            ['AA08F0EF004682BB'],
        )

        t.mock.timers.tick(30_000)
        assert.deepEqual(
            thinq.outbox.map((packet) => packet.toString('hex').toUpperCase()),
            ['AA08F0EF004682BB', 'AA08F0EF004682BB'],
        )

        dev.drop()
        t.mock.timers.tick(30_000)
        assert.equal(thinq.outbox.length, 2)
    })

    test('publishes exactly five Korean read-only entities', () => {
        const { ha } = makeDevice()
        const config = ha.devices[DEVICE_ID].config!
        assert.equal(config.device.name, 'LG 광파오븐')
        assert.deepEqual(Object.keys(config.components), [
            'status',
            'active_program',
            'remaining_time',
            'target_temperature',
            'total_time',
        ])
        const components = config.components as Record<string, ComponentInfo>
        assert.equal(components.status.name, '상태')
        assert.equal(components.active_program.name, '현재 코스')
        assert.equal(components.remaining_time.name, '남은 시간')
        assert.equal(components.target_temperature.name, '목표 온도')
        assert.equal(components.total_time.name, '총 시간')
        for (const component of Object.values(config.components)) assert.equal('command_topic' in component, false)
        assert.deepEqual(ha.configHistory[0].config.components.cooking, { platform: 'binary_sensor' })
    })

    test('uses English entity and state names outside Korea', () => {
        const { ha, thinq } = makeDevice({ ...META, countryCode: 'US' })
        thinq.emit('data', statePacket(record(0x02, 0x04, 0, 0, 2, 0, 180), record(0x07)))
        const config = ha.devices[DEVICE_ID].config!
        assert.equal(config.device.name, 'LG Lightwave Oven')
        assert.equal((config.components.active_program as ComponentInfo).name, 'Active program')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Cooking')
        assert.equal(ha.devices[DEVICE_ID].properties.active_program, 'Oven')
    })

    test('decodes the captured 10-second microwave cycle start', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit(
            'data',
            buf(
                'AA3E40EC0701000000000000000000000000000000000000000000000000000002010000000A000000000000000000000000000000000000000000007CBB',
            ),
        )
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: '조리 중',
            active_program: '레인지',
            remaining_time: 10,
            target_temperature: 'None',
            total_time: 10,
        })
    })

    test('decodes oven preheating without exposing its untrustworthy time as remaining or total', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', statePacket(record(0x01, 0x04, 0, 0, 30, 0, 180), record(0x07, 0x04, 0, 0, 0, 0, 180)))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: '예열 중',
            active_program: '오븐',
            remaining_time: 'None',
            target_temperature: 180,
            total_time: 'None',
        })
    })

    test('keeps a latched total through pause and resume, then clears the cycle on cancellation', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', statePacket(record(0x02, 0x04, 0, 0, 2, 0, 180), record(0x07, 0x04)))
        thinq.emit('data', statePacket(record(0x04, 0x04, 0, 0, 1, 34, 180), record(0x02, 0x04)))
        assert.equal(ha.devices[DEVICE_ID].properties.total_time, 120)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 94)

        thinq.emit('data', statePacket(record(0x02, 0x04, 0, 0, 1, 33, 180), record(0x04, 0x04)))
        assert.equal(ha.devices[DEVICE_ID].properties.total_time, 120)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 93)

        thinq.emit('data', statePacket(record(0x00), record(0x04, 0x04, 0, 0, 1, 12, 180)))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: '대기',
            active_program: '알 수 없음',
            remaining_time: 'None',
            target_temperature: 'None',
            total_time: 'None',
        })
    })

    test('decodes captured cleaning contexts and preserves them while paused', () => {
        for (const [subId, name, seconds] of [
            [0x02, '스팀청소', 900],
            [0x03, '조리실건조', 720],
        ] as const) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', statePacket(record(0x03, 0x12, subId, 0, seconds / 60), record(0x07)))
            assert.equal(ha.devices[DEVICE_ID].properties.status, '청소 중')
            assert.equal(ha.devices[DEVICE_ID].properties.active_program, name)
            assert.equal(ha.devices[DEVICE_ID].properties.total_time, seconds)

            thinq.emit(
                'data',
                statePacket(record(0x04, 0x12, subId, 0, seconds / 60 - 1, 33), record(0x03, 0x12, subId)),
            )
            assert.equal(ha.devices[DEVICE_ID].properties.status, '일시정지')
            assert.equal(ha.devices[DEVICE_ID].properties.active_program, name)
            assert.equal(ha.devices[DEVICE_ID].properties.total_time, seconds)
        }
    })

    test('maps externally documented programs only in active program contexts', () => {
        for (const [id, name] of [
            [0x02, '스팀레인지'],
            [0x03, '구이'],
            [0x06, '스팀'],
            [0x07, '식품건조'],
            [0x15, '발효'],
            [0x16, '스팀발효'],
        ] as const) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', statePacket(record(0x02, id, 0, 0, 1), record(0x07)))
            assert.equal(ha.devices[DEVICE_ID].properties.active_program, name)
        }

        const { ha, thinq } = makeDevice()
        thinq.emit('data', statePacket(record(0x07, 0x15, 0, 0, 1), record(0x00)))
        assert.equal(ha.devices[DEVICE_ID].properties.active_program, '알 수 없음')

        thinq.emit('data', statePacket(record(0x02, 0x13, 0, 0, 1, 0, 180), record(0x07, 0x13)))
        assert.equal(ha.devices[DEVICE_ID].properties.active_program, '내가 만든 레시피')
        assert.equal(ha.devices[DEVICE_ID].properties.target_temperature, 180)
    })

    test('maps externally documented cleaning functions only under the cleaning marker', () => {
        for (const [subId, name] of [
            [0x01, '스팀청소탈취'],
            [0x04, '잔수제거'],
            [0x05, '스팀발생기세정'],
        ] as const) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', statePacket(record(0x03, 0x12, subId, 0, 1), record(0x07)))
            assert.equal(ha.devices[DEVICE_ID].properties.active_program, name)
        }
    })

    test('clears stale values in setting and complete states', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', statePacket(record(0x02, 0x04, 0, 0, 2, 0, 180), record(0x07)))
        thinq.emit('data', statePacket(record(0x07, 0x13, 0, 0, 1, 12, 180), record(0x00)))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: '설정',
            active_program: '알 수 없음',
            remaining_time: 'None',
            target_temperature: 'None',
            total_time: 'None',
        })

        thinq.emit('data', statePacket(record(0x05), record(0x02, 0, 0, 0, 0, 0, 180)))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: '완료',
            active_program: '알 수 없음',
            remaining_time: 'None',
            target_temperature: 'None',
            total_time: 'None',
        })
    })

    test('does not retain a temperature after the course context is cleared at the end of cooking', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', statePacket(record(0x02, 0x04, 0, 0, 0, 20, 180), record(0x07)))
        thinq.emit('data', statePacket(record(0x02, 0x00, 0, 0, 0, 0, 180), record(0x02, 0x04, 0, 0, 0, 1, 180)))
        assert.equal(ha.devices[DEVICE_ID].properties.active_program, '알 수 없음')
        assert.equal(ha.devices[DEVICE_ID].properties.target_temperature, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.total_time, 20)
    })

    test('does not use 4072 or 40BF as authoritative state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', statePacket(record(0x02, 0x04, 0, 0, 0, 20, 180), record(0x07)))
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', buf('AA13407200040A0000000000000000000028BB'))
        thinq.emit('data', packet(Buffer.from([0x40, 0xbf, 0x02, 0x00])))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('does not mistake a reconnect snapshot for the total cycle time', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', reconnectPacket(record(0x02, 0x04, 0, 0, 8, 30, 220)))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: '조리 중',
            active_program: '오븐',
            remaining_time: 510,
            target_temperature: 220,
            total_time: 'None',
        })
    })

    test('leaves contradictory and unknown contexts unknown', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', statePacket(record(0x03, 0x04, 0, 0, 12), record(0x07)))
        assert.equal(ha.devices[DEVICE_ID].properties.active_program, '알 수 없는 청소 기능 (0x04)')

        thinq.emit('data', statePacket(record(0x99, 0x04, 0, 0, 1, 0, 180), record(0x03, 0x04)))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: '알 수 없는 상태 (0x99)',
            active_program: '알 수 없음',
            remaining_time: 'None',
            target_temperature: 'None',
            total_time: 'None',
        })
    })
})
