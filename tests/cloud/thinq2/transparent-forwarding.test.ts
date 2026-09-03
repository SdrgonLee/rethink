import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import type { MqttClient, IClientPublishOptions } from 'mqtt'
import { Broker, type PublishPacket } from '@/cloud/mqtt-broker'
import { Device, DeviceAcceptor } from '@/cloud/thinq2/device'
import type { BridgeMessage } from '@/cloud/thinq2/bridge-message'
import type { ClipDeployMessage } from '@/cloud/thinq2/clip'
import { Connection } from '@/bridge/thinq2connection'
import { Thinq2Device, type Thinq2DeviceState } from '@/bridge/thinqApi'

const DEVICE_ID = 'device-id'
const LOCAL_TOPIC = `lime/devices/${DEVICE_ID}`
const LOCAL_MESSAGE_TOPIC = `clip/message/devices/${DEVICE_ID}`
const LOCAL_PROVISIONING_TOPIC = `clip/provisioning/devices/${DEVICE_ID}`

const DEPLOY_MESSAGE = {
    did: DEVICE_ID,
    mid: 1,
    kind: 'TEST_MODEL',
    cmd: 'deploy',
    type: 0,
    data: {
        appInfo: {
            modelName: 'TEST_MODEL',
            DeviceType: '201',
            modelLanguage: '01',
            countryCode: 'KR',
            subCountryCode: 'KR',
        },
    },
} as ClipDeployMessage

type LocalClient = {
    deviceObj?: Device
    deployMsg?: ClipDeployMessage
}

function localHarness() {
    const broker = new Broker()
    new DeviceAcceptor(broker)
    const device = new Device(broker, LOCAL_TOPIC, DEVICE_ID, {
        modelId: 'TEST_MODEL',
        modelName: 'TEST_MODEL',
    })
    const client: LocalClient = { deviceObj: device, deployMsg: DEPLOY_MESSAGE }
    const forwarded: BridgeMessage[] = []
    const decoded: Buffer[] = []
    device.onBridgeMessage((message) => forwarded.push(message))
    device.on('data', (data) => decoded.push(data))

    function publish(payload: Buffer, topic = LOCAL_MESSAGE_TOPIC, qos: 0 | 1 | 2 = 1, retain = false) {
        const packet: PublishPacket = { topic, qos, retain, dup: false, payload }
        broker.emit('publish', packet, client as never)
    }

    return { broker, device, client, forwarded, decoded, publish }
}

class FakeMqttClient extends EventEmitter {
    published: Array<{ topic: string; payload: Buffer; options?: IClientPublishOptions }> = []

    publish(topic: string, payload: string | Buffer, options?: IClientPublishOptions) {
        this.published.push({ topic, payload: Buffer.from(payload), options })
        return this
    }

    subscribe() {
        return this
    }

    end() {
        return this
    }
}

const CLOUD_STATE: Thinq2DeviceState = {
    countryCode: 'KR',
    apiServer: 'https://api.example',
    mqttServer: 'ssl://mqtt.example',
    caCertificate: 'ca',
    privateKey: 'key',
    certificate: 'cert',
    pubTopic: `cloud/pub/${DEVICE_ID}`,
    provTopic: `cloud/provision/${DEVICE_ID}`,
    subTopic: `cloud/sub/${DEVICE_ID}`,
}

function cloudHarness() {
    const mqtt = new FakeMqttClient()
    const device = new Thinq2Device(DEVICE_ID, { modelId: 'TEST_MODEL', modelName: 'TEST_MODEL' }, CLOUD_STATE)
    const connection = new Connection(device, (() => mqtt as unknown as MqttClient) as never)
    const forwarded: BridgeMessage[] = []
    connection.on('bridgeMessage', (message) => forwarded.push(message))

    function receive(payload: Buffer, qos: 0 | 1 | 2 = 1, retain = false) {
        mqtt.emit('message', CLOUD_STATE.subTopic, payload, { qos, retain, dup: false, messageId: 77 })
    }

    return { mqtt, connection, forwarded, receive }
}

describe('ThinQ2 device to cloud transparent forwarding', () => {
    test('preserves locale metadata from provisioning for Home Assistant display names', () => {
        const broker = new Broker()
        const acceptor = new DeviceAcceptor(broker)
        const client = { deviceObj: undefined, deployMsg: DEPLOY_MESSAGE }
        let provisioned: Device | undefined
        acceptor.on('newDevice', (device) => (provisioned = device))

        acceptor.completeProvisioning(
            DEVICE_ID,
            { did: DEVICE_ID, mid: 2, cmd: 'completeProvisioning_ack', type: 1, data: null },
            client as never,
        )

        assert.equal(provisioned?.meta.modelLanguage, '01')
        assert.equal(provisioned?.meta.countryCode, 'KR')
        assert.equal(provisioned?.meta.subCountryCode, 'KR')
    })

    test('preserves device_packet bytes while independently decoding data for HA', () => {
        const h = localHarness()
        const raw = Buffer.concat([
            Buffer.from(
                `{ "mid" : 123456789, "did":"${DEVICE_ID}", "cmd":"device_packet", "type":7, "data":"A10B", "unknownTopLevel":{"future":true} }`,
            ),
            Buffer.from([0]),
        ])

        h.publish(raw, LOCAL_MESSAGE_TOPIC, 1, true)

        assert.equal(h.forwarded.length, 1)
        assert.deepEqual(h.forwarded[0].payload, raw)
        assert.equal(h.forwarded[0].sourceTopic, LOCAL_MESSAGE_TOPIC)
        assert.equal(h.forwarded[0].qos, 1)
        assert.equal(h.forwarded[0].retain, true)
        assert.deepEqual(h.decoded, [Buffer.from('A10B', 'hex')])
    })

    test('passes through modem_cmd and unknown valid commands without HA data events', () => {
        const h = localHarness()
        const modem = Buffer.from(
            `{ "mid":12,"did":"${DEVICE_ID}","cmd":"modem_cmd","type":7,"data":{"foo":"bar"},"unknown":1 }`,
        )
        const future = Buffer.from(`{"did":"${DEVICE_ID}","mid":13,"cmd":"future_command_123","x":true}`)

        h.publish(modem)
        h.publish(future)

        assert.deepEqual(
            h.forwarded.map((message) => message.payload),
            [modem, future],
        )
        assert.deepEqual(h.decoded, [])
    })

    test('does not forward local-only lifecycle or timesync messages', () => {
        const h = localHarness()
        const outgoing: PublishPacket[] = []
        h.broker.on('publish', (packet, client) => {
            if (!client) outgoing.push(packet)
        })

        h.publish(Buffer.from(JSON.stringify({ ...DEPLOY_MESSAGE, cmd: 'preDeploy' })), LOCAL_PROVISIONING_TOPIC)
        h.publish(Buffer.from(JSON.stringify(DEPLOY_MESSAGE)), LOCAL_PROVISIONING_TOPIC)
        h.publish(Buffer.from(JSON.stringify({ did: DEVICE_ID, mid: 2, cmd: 'completeProvisioning_ack', type: 1 })))
        h.publish(Buffer.from(JSON.stringify({ did: DEVICE_ID, mid: 3, cmd: 'req_timesync', type: 1 })))

        assert.deepEqual(h.forwarded, [])
        assert.equal(outgoing.length, 3)
        assert.deepEqual(
            outgoing.map((packet) => JSON.parse(packet.payload.toString()).cmd),
            ['completeProvisioning', 'completeProvisioning', 'resp_timesync'],
        )
    })

    test('isolates HA and bridge listener failures in both directions', () => {
        const haFailure = localHarness()
        haFailure.device.on('data', () => {
            throw new Error('HA failed')
        })
        const packet = Buffer.from(
            JSON.stringify({ did: DEVICE_ID, mid: 4, cmd: 'device_packet', type: 1, data: 'CAFE' }),
        )
        assert.doesNotThrow(() => haFailure.publish(packet))
        assert.deepEqual(haFailure.forwarded[0].payload, packet)

        const bridgeFailure = localHarness()
        bridgeFailure.device.onBridgeMessage(() => {
            throw new Error('bridge failed')
        })
        assert.doesNotThrow(() => bridgeFailure.publish(packet))
        assert.deepEqual(bridgeFailure.decoded, [Buffer.from('CAFE', 'hex')])
    })

    test('rejects wrong-device, wrong-topic, and malformed messages', () => {
        const h = localHarness()
        h.publish(Buffer.from(JSON.stringify({ did: 'other-device', cmd: 'device_packet', data: 'AA' })))
        h.publish(
            Buffer.from(JSON.stringify({ did: DEVICE_ID, cmd: 'device_packet', data: 'BB' })),
            'clip/message/devices/other-device',
        )
        assert.doesNotThrow(() => h.publish(Buffer.from('{not-json')))

        assert.deepEqual(h.forwarded, [])
        assert.deepEqual(h.decoded, [])
    })
})

describe('ThinQ2 cloud to device transparent forwarding', () => {
    test('passes packet, ack, modem_cmd and unknown commands through byte-for-byte', () => {
        const h = cloudHarness()
        const messages = [
            Buffer.from(`{ "mid":20,"did":"${DEVICE_ID}","cmd":"packet","data":"AA","extra":1 }`),
            Buffer.from(`{"mid":21,"did":"${DEVICE_ID}","cmd":"ack","data":"BB","unknown":{"x":1}}`),
            Buffer.from(`{"mid":22,"did":"${DEVICE_ID}","cmd":"modem_cmd","data":{"foo":"bar"}}`),
            Buffer.from(`{"mid":23,"did":"${DEVICE_ID}","cmd":"future_cloud_command","future":true}`),
        ]

        for (const message of messages) h.receive(message)

        assert.deepEqual(
            h.forwarded.map((message) => message.payload),
            messages,
        )
        assert.ok(h.forwarded.every((message) => message.sourceTopic === CLOUD_STATE.subTopic))
    })

    test('terminates cloud completeProvisioning locally and does not forward it', () => {
        const h = cloudHarness()
        const provisioning = Buffer.from(
            JSON.stringify({ did: DEVICE_ID, mid: 30, cmd: 'completeProvisioning', type: 0, data: {} }),
        )

        h.receive(provisioning)

        assert.deepEqual(h.forwarded, [])
        assert.equal(h.mqtt.published.length, 1)
        assert.equal(h.mqtt.published[0].topic, CLOUD_STATE.pubTopic)
        assert.equal(JSON.parse(h.mqtt.published[0].payload.toString()).cmd, 'completeProvisioning_ack')
    })

    test('publishes raw device payload to the provisioned cloud topic with destination QoS policy', () => {
        const h = cloudHarness()
        const raw = Buffer.from(
            `{ "mid":123,"did":"${DEVICE_ID}","cmd":"modem_cmd","unknownTopLevel":{"future":true} }`,
        )

        h.connection.forward({ sourceTopic: 'local/source', qos: 2, retain: true, payload: raw })

        assert.equal(h.mqtt.published.length, 1)
        assert.equal(h.mqtt.published[0].topic, CLOUD_STATE.pubTopic)
        assert.deepEqual(h.mqtt.published[0].payload, raw)
        assert.equal(h.mqtt.published[0].options?.qos, 0)
        assert.equal(h.mqtt.published[0].options?.retain, false)
    })

    test('drops malformed and wrong-device cloud payloads', () => {
        const h = cloudHarness()
        assert.doesNotThrow(() => h.receive(Buffer.from('{not-json')))
        h.receive(Buffer.from(JSON.stringify({ did: 'other-device', cmd: 'ack', mid: 40 })))
        assert.deepEqual(h.forwarded, [])
    })

    test('publishes to the local device topic once without feeding the outgoing packet back', () => {
        const broker = new Broker()
        new DeviceAcceptor(broker)
        const device = new Device(broker, LOCAL_TOPIC, DEVICE_ID, {
            modelId: 'TEST_MODEL',
            modelName: 'TEST_MODEL',
        })
        const raw = Buffer.from(`{"did":"${DEVICE_ID}","mid":50,"cmd":"ack"}`)
        const published: Array<{ packet: PublishPacket; client: unknown }> = []
        let bridgeEvents = 0
        const sendEvents: BridgeMessage[] = []
        device.onBridgeMessage(() => bridgeEvents++)
        device.onBridgeSendMessage((message) => sendEvents.push(message))
        broker.on('publish', (packet, client) => published.push({ packet, client }))

        const message = { sourceTopic: CLOUD_STATE.subTopic, qos: 1 as const, retain: true, payload: raw }
        device.sendBridgeMessage(message)

        assert.equal(published.length, 1)
        assert.equal(published[0].client, null)
        assert.equal(published[0].packet.topic, LOCAL_TOPIC)
        assert.equal(published[0].packet.qos, 0)
        assert.equal(published[0].packet.retain, false)
        assert.deepEqual(published[0].packet.payload, raw)
        assert.equal(bridgeEvents, 0)
        assert.deepEqual(sendEvents, [message])
    })

    test('does not let a cloud-to-device capture observer break forwarding', () => {
        const broker = new Broker()
        const device = new Device(broker, LOCAL_TOPIC, DEVICE_ID, {
            modelId: 'TEST_MODEL',
            modelName: 'TEST_MODEL',
        })
        const published: PublishPacket[] = []
        broker.on('publish', (packet) => published.push(packet))
        device.onBridgeSendMessage(() => {
            throw new Error('capture failed')
        })

        assert.doesNotThrow(() =>
            device.sendBridgeMessage({
                sourceTopic: CLOUD_STATE.subTopic,
                qos: 1,
                retain: false,
                payload: Buffer.from(`{"did":"${DEVICE_ID}","cmd":"power_off"}`),
            }),
        )
        assert.equal(published.length, 1)
    })
})
