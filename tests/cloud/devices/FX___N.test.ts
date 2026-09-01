import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/FX___N'
import { MockHAConnection, MockThinq2Device, buf } from '../../helpers/mocks'
import type { Metadata } from '@/cloud/thinq'

const DEVICE_ID = 'fx25-device'
const META: Metadata = { modelId: 'FX___N', modelName: 'FX___N', swVersion: '2.11.296', deviceType: '201' }

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

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('FX___N', () => {
    test('publishes read-only Home Assistant discovery entities', () => {
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
        assert.equal(p.error, 'None')
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
