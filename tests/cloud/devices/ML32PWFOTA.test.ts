import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/ML32PWFOTA'
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

function record(state: number, hour = 0, minute = 0, second = 0): Buffer {
    const result = Buffer.alloc(28)
    result[0] = state
    result[3] = hour
    result[4] = minute
    result[5] = second
    return result
}

function makeDevice(meta = META) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, meta)
    const dev = new DUT(ha.asConnection(), thinq, meta)
    return { ha, thinq, dev }
}

describe('ML32PWFOTA', () => {
    test('publishes Korean read-only oven entities', () => {
        const { ha } = makeDevice()
        const config = ha.devices[DEVICE_ID].config!
        assert.equal(config.device.name, 'LG 광파오븐')
        assert.deepEqual(Object.keys(config.components), ['status', 'remaining_time', 'cooking'])
        assert.equal(config.components.status.name, '상태')
        assert.equal(config.components.remaining_time.name, '남은 시간')
        assert.equal(config.components.cooking.name, '조리 중')
        assert.equal('command_topic' in config.components.status, false)
    })

    test('uses English names when the registration is not Korean', () => {
        const { ha } = makeDevice({ ...META, countryCode: 'US' })
        const config = ha.devices[DEVICE_ID].config!
        assert.equal(config.device.name, 'LG Lightwave Oven')
        assert.equal(config.components.remaining_time.name, 'Remaining time')
    })

    test('decodes the reconnect state block', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', packet(Buffer.concat([Buffer.from([0x40, 0xeb]), record(0x00)])))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: '대기',
            remaining_time: 0,
            cooking: 'OFF',
        })
    })

    test('uses the second EC block as current and converts h:m:s to seconds', () => {
        const { ha, thinq } = makeDevice()
        const previous = record(0x07)
        const current = record(0x02, 1, 4, 30)
        thinq.emit('data', packet(Buffer.concat([Buffer.from([0x40, 0xec]), previous, current])))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: '조리',
            remaining_time: 3870,
            cooking: 'ON',
        })
    })

    test('decodes paused, setting, and complete states', () => {
        for (const [state, expected, cooking] of [
            [0x04, '일시정지', 'OFF'],
            [0x07, '설정', 'OFF'],
            [0x05, '완료', 'OFF'],
        ] as const) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', packet(Buffer.concat([Buffer.from([0x40, 0xeb]), record(state, 0, 0, 6)])))
            assert.equal(ha.devices[DEVICE_ID].properties.status, expected)
            assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 6)
            assert.equal(ha.devices[DEVICE_ID].properties.cooking, cooking)
        }
    })

    test('the captured completion event closes cycles that have no EC update', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', packet(Buffer.concat([Buffer.from([0x40, 0xeb]), record(0x02, 0, 4, 0)])))
        thinq.emit('data', buf('AA13407200040A0000000000000000000028BB'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: '완료',
            remaining_time: 0,
            cooking: 'OFF',
        })
    })

    test('ignores other device types, malformed state frames, and undecoded BF frames', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', packet(Buffer.concat([Buffer.from([0x30, 0xeb]), record(0x02)])))
        thinq.emit('data', packet(Buffer.from([0x40, 0xec, 0x02])))
        thinq.emit('data', packet(Buffer.from([0x40, 0xbf, 0x02, 0x00])))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })

    test('preserves an unknown state code instead of assigning a guessed meaning', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', packet(Buffer.concat([Buffer.from([0x40, 0xeb]), record(0x99)])))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Code 153')
        assert.equal(ha.devices[DEVICE_ID].properties.cooking, 'OFF')
    })
})
