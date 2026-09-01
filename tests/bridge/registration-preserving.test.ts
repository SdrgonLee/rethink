import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Bridge, registrationPlan } from '@/bridge/index'
import type { BridgeState } from '@/bridge/state'
import {
    Thinq2Device,
    type Environment,
    type HomeDevice,
    type Thinq1DeviceState,
    type Thinq2DeviceState,
} from '@/bridge/thinqApi'
import { DeviceManager, type AnyDevice } from '@/cloud/devmgr'
import type { Metadata } from '@/cloud/thinq'

const ENV: Environment = { countryCode: 'KR' }
const META: Metadata = { modelId: 'TEST_MODEL', modelName: 'TEST_MODEL', deviceType: '201' }
const TARGET_ID = 'target-device'
const BRIDGE_STATE: Thinq2DeviceState = {
    countryCode: 'KR',
    apiServer: 'https://api.example',
    mqttServer: 'ssl://mqtt.example',
    caCertificate: 'ca',
    privateKey: 'key',
    certificate: 'cert',
    pubTopic: 'publish/topic',
    provTopic: 'provision/topic',
    subTopic: 'subscribe/topic',
}

function homeDevice(id = TARGET_ID, alias = '사용자 기존 이름'): HomeDevice {
    return {
        deviceId: id,
        deviceType: 201,
        modelName: META.modelName,
        alias,
        snapshot: {},
        online: true,
    }
}

function physicalDevice(platform: 'thinq1' | 'thinq2' = 'thinq2'): AnyDevice {
    return { id: TARGET_ID, platform, meta: META } as AnyDevice
}

function recordingState() {
    const writes: Array<{ id: string; value: Thinq1DeviceState | Thinq2DeviceState | undefined }> = []
    const state: BridgeState = {
        getCredentials: () => undefined,
        setCredentials: () => {},
        getDeviceState: () => undefined,
        setDeviceState: (id, value) => writes.push({ id, value }),
    }
    return { state, writes }
}

type AddCall = {
    alias: string
    allowInitDeviceRecovery: boolean | undefined
}

class FakeClient {
    readonly env = ENV
    removeCalls = 0
    prepareCalls = 0
    addCalls: AddCall[] = []
    listCalls = 0
    addError?: Error

    constructor(readonly devices: HomeDevice[]) {}

    async listDevices() {
        this.listCalls++
        return this.devices
    }

    async removeDevice() {
        this.removeCalls++
    }

    async prepareNewT2Device() {
        this.prepareCalls++
        return { otp: 'otp', publicKey: 'unused-by-test' }
    }

    async addDevice(
        _device: unknown,
        alias: string,
        _deviceType: string,
        _ciphertext?: Buffer,
        allowInitDeviceRecovery?: boolean,
    ) {
        this.addCalls.push({ alias, allowInitDeviceRecovery })
        if (this.addError) throw this.addError
    }
}

function harness(devices: HomeDevice[] = []) {
    const { state, writes } = recordingState()
    const client = new FakeClient(devices)
    let pairCalls = 0
    let pairError: Error | undefined
    const bridge = new Bridge(state, new DeviceManager(), {
        preserveExistingDevices: true,
        createThinq2Device: (id, meta) => {
            const device = new Thinq2Device(id, meta)
            device.pair = async () => {
                pairCalls++
                if (pairError) throw pairError
                device.state = BRIDGE_STATE
                return Buffer.from('ciphertext')
            }
            return device
        },
    })
    return {
        bridge,
        client,
        writes,
        pairCalls: () => pairCalls,
        failPairWith: (error: Error) => (pairError = error),
    }
}

describe('registration-preserving ThinQ bridge', () => {
    test('decision helper rejects ThinQ1 before destructive work', () => {
        assert.throws(() => registrationPlan('thinq1', TARGET_ID, true), /only for ThinQ2/)
        assert.equal(registrationPlan('thinq1', TARGET_ID, false), 'replace')
    })

    test('preserves an existing ThinQ2 registration and alias while creating bridge credentials', async () => {
        const h = harness([homeDevice()])

        await h.bridge.register(h.client as never, physicalDevice(), META.deviceType)

        assert.equal(h.client.listCalls, 1)
        assert.equal(h.client.removeCalls, 0)
        assert.equal(h.client.prepareCalls, 1)
        assert.equal(h.pairCalls(), 1)
        assert.deepEqual(h.client.addCalls, [])
        assert.deepEqual(h.writes, [{ id: TARGET_ID, value: BRIDGE_STATE }])
    })

    test('registers a genuinely new ThinQ2 device without destructive recovery', async () => {
        const h = harness([homeDevice('different-device')])

        await h.bridge.register(h.client as never, physicalDevice(), META.deviceType)

        assert.equal(h.client.removeCalls, 0)
        assert.equal(h.client.prepareCalls, 1)
        assert.equal(h.pairCalls(), 1)
        assert.deepEqual(h.client.addCalls, [
            { alias: `Rethink ${TARGET_ID.substring(0, 8)}`, allowInitDeviceRecovery: false },
        ])
        assert.equal(h.writes.length, 1)
    })

    test('fails explicitly when registration conflicts outside the current Home', async () => {
        const h = harness([])
        h.client.addError = new Error('already registered; refusing initDevice:true recovery')

        await assert.rejects(
            h.bridge.register(h.client as never, physicalDevice(), META.deviceType),
            /refusing initDevice:true/,
        )

        assert.deepEqual(h.client.addCalls, [
            { alias: `Rethink ${TARGET_ID.substring(0, 8)}`, allowInitDeviceRecovery: false },
        ])
        assert.deepEqual(h.writes, [])
    })

    test('rejects ThinQ1 preserve mode without removing or registering the device', async () => {
        const h = harness([])

        await assert.rejects(
            h.bridge.register(h.client as never, physicalDevice('thinq1'), META.deviceType),
            /only for ThinQ2/,
        )

        assert.equal(h.client.listCalls, 0)
        assert.equal(h.client.removeCalls, 0)
        assert.equal(h.client.prepareCalls, 0)
        assert.deepEqual(h.client.addCalls, [])
        assert.deepEqual(h.writes, [])
    })

    test('keeps the upstream destructive recovery policy when preserve mode is disabled', async () => {
        const { state, writes } = recordingState()
        const client = new FakeClient([])
        let pairCalls = 0
        const bridge = new Bridge(state, new DeviceManager(), {
            createThinq2Device: (id, meta) => {
                const device = new Thinq2Device(id, meta)
                device.pair = async () => {
                    pairCalls++
                    device.state = BRIDGE_STATE
                    return Buffer.from('ciphertext')
                }
                return device
            },
        })

        await bridge.register(client as never, physicalDevice(), META.deviceType)

        assert.equal(client.listCalls, 0)
        assert.equal(client.removeCalls, 1)
        assert.equal(pairCalls, 1)
        assert.deepEqual(client.addCalls, [
            { alias: `Rethink ${TARGET_ID.substring(0, 8)}`, allowInitDeviceRecovery: true },
        ])
        assert.equal(writes.length, 1)
    })

    test('does not persist partial state when pairing or Home registration fails', async () => {
        const pairFailure = harness([])
        pairFailure.failPairWith(new Error('pair failed'))
        await assert.rejects(
            pairFailure.bridge.register(pairFailure.client as never, physicalDevice(), META.deviceType),
            /pair failed/,
        )
        assert.deepEqual(pairFailure.writes, [])

        const registrationFailure = harness([])
        registrationFailure.client.addError = new Error('registration failed')
        await assert.rejects(
            registrationFailure.bridge.register(registrationFailure.client as never, physicalDevice(), META.deviceType),
            /registration failed/,
        )
        assert.deepEqual(registrationFailure.writes, [])
    })
})
