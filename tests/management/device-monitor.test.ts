import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import WebSocket from 'ws'
import type HA_bridge from '@/cloud/ha_bridge'
import { DeviceManager } from '@/cloud/devmgr'
import { app } from '@/management'
import { MockThinq1Device } from '../helpers/mocks'
import { Broker } from '@/cloud/mqtt-broker'
import { Device as T2Device } from '@/cloud/thinq2/device'
import type { BridgeMessage } from '@/cloud/thinq2/bridge-message'

async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 1000
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('timed out waiting for server-side WebSocket cleanup')
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

test('device monitor detaches device and manager listeners after a real WebSocket close', async () => {
    const haStatus = Object.assign(new EventEmitter(), { isConnected: true })
    const ha = { HA: haStatus, haDevices: new Map() } as unknown as HA_bridge
    const manager = new DeviceManager()
    const device = new MockThinq1Device('device-1', {
        modelId: 'model-id',
        modelName: 'model-name',
        deviceType: '401',
    })
    manager.accept(device)

    const server = app(ha, manager, undefined)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device?id=device-1`)
    const firstMessage = once(ws, 'message')
    await once(ws, 'open')
    await firstMessage

    assert.equal(device.listenerCount('data'), 1)
    assert.equal(device.listenerCount('sendData'), 1)
    assert.equal(manager.listenerCount('newDevice'), 2)
    assert.equal(manager.listenerCount('dropDevice'), 2)

    ws.close()
    await once(ws, 'close')
    await waitFor(() => device.listenerCount('data') === 0)

    assert.equal(device.listenerCount('data'), 0)
    assert.equal(device.listenerCount('sendData'), 0)
    assert.equal(manager.listenerCount('newDevice'), 1)
    assert.equal(manager.listenerCount('dropDevice'), 1)

    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
    })
    assert.equal(manager.listenerCount('newDevice'), 0)
    assert.equal(manager.listenerCount('dropDevice'), 0)
    assert.equal(haStatus.listenerCount('statusChanged'), 0)
})

test('server shutdown closes a connected device monitor and detaches all listeners', async () => {
    const haStatus = Object.assign(new EventEmitter(), { isConnected: true })
    const ha = { HA: haStatus, haDevices: new Map() } as unknown as HA_bridge
    const manager = new DeviceManager()
    const device = new MockThinq1Device('device-1', {
        modelId: 'model-id',
        modelName: 'model-name',
        deviceType: '401',
    })
    manager.accept(device)

    const server = app(ha, manager, undefined)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device?id=device-1`)
    const firstMessage = once(ws, 'message')
    await once(ws, 'open')
    await firstMessage

    const websocketClosed = once(ws, 'close')
    const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
    })
    await Promise.all([websocketClosed, serverClosed])

    assert.equal(device.listenerCount('data'), 0)
    assert.equal(device.listenerCount('sendData'), 0)
    assert.equal(manager.listenerCount('newDevice'), 0)
    assert.equal(manager.listenerCount('dropDevice'), 0)
    assert.equal(haStatus.listenerCount('statusChanged'), 0)
})

test('device monitor captures ThinQ2 application messages without exposing source topics', async () => {
    const haStatus = Object.assign(new EventEmitter(), { isConnected: true })
    const ha = { HA: haStatus, haDevices: new Map() } as unknown as HA_bridge
    const manager = new DeviceManager()
    const broker = new Broker()
    const device = new T2Device(broker, 'lime/devices/device-2', 'device-2', {
        modelId: 'FX___N',
        modelName: 'FX___N',
        deviceType: '201',
    })
    manager.accept(device)

    const server = app(ha, manager, undefined)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device?id=device-2`)
    const firstMessage = once(ws, 'message')
    await once(ws, 'open')
    await firstMessage

    const received: string[] = []
    const messagesReceived = new Promise<void>((resolve) => {
        ws.on('message', (data) => {
            received.push(data.toString())
            if (received.length === 2) resolve()
        })
    })
    const fromDevice: BridgeMessage = {
        sourceTopic: 'account/sensitive/from-device/topic',
        qos: 1,
        retain: true,
        payload: Buffer.from('{"did":"device-2","cmd":"device_packet","data":"AA"}'),
    }
    const toDevice: BridgeMessage = {
        sourceTopic: 'account/sensitive/to-device/topic',
        qos: 2,
        retain: false,
        payload: Buffer.from('{"did":"device-2","cmd":"remote_control","data":{"power":"off"}}'),
    }

    device.emitBridgeMessage(fromDevice)
    device.sendBridgeMessage(toDevice)
    await messagesReceived

    const decoded = received.map((message) => JSON.parse(message))
    assert.deepEqual(decoded, [
        {
            application: {
                direction: 'fromDevice',
                qos: 1,
                retain: true,
                payload: fromDevice.payload.toString('base64'),
            },
            injected: false,
        },
        {
            application: {
                direction: 'toDevice',
                qos: 2,
                retain: false,
                payload: toDevice.payload.toString('base64'),
            },
            injected: false,
        },
    ])
    assert.ok(received.every((message) => !message.includes('account/sensitive')))

    assert.equal((device as any).bridgeMessageListeners.size, 1)
    assert.equal((device as any).bridgeSendMessageListeners.size, 1)
    ws.close()
    await once(ws, 'close')
    await waitFor(() => (device as any).bridgeMessageListeners.size === 0)
    assert.equal((device as any).bridgeMessageListeners.size, 0)
    assert.equal((device as any).bridgeSendMessageListeners.size, 0)

    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
    })
})
