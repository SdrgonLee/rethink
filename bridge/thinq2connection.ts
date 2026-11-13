import * as mqtt from 'mqtt'
import type { ConnectionOptions } from 'node:tls'
import { Thinq2Device } from './thinqApi'
import { TypedEmitter } from 'tiny-typed-emitter'
import {
    applicationFrame,
    format,
    type ClipPayload,
    type DeployAppInfo,
    type DeployPayload,
    type DeployPlatformInfo,
} from '@/cloud/thinq2/clip'
import log from '@/util/logging'
import { lookup } from './resolver'

type ConnectionEvents = {
    ready: () => void
    packet: (packet: ClipPayload) => void
    close: () => void
    error: (error: Error) => void
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    mqtt: mqtt.MqttClient
    mid = 10000

    constructor(
        readonly device: Thinq2Device,
        // The appliance's deploy message is forwarded mostly verbatim, so the cloud sees its true
        // protocolVer - which decides how it frames its reservation polls.
        readonly deployAppInfo: DeployAppInfo,
        readonly deployPlatformInfo: DeployPlatformInfo,
    ) {
        super()
        const state = this.device.state!
        log('bridge', `${this.device.deviceId} connecting to ${state.mqttServer}`)
        // mqtt.js passes the options on to tls.connect, but its typings don't list `lookup`
        const options: mqtt.IClientOptions & Pick<ConnectionOptions, 'lookup'> = {
            ca: state.caCertificate,
            key: state.privateKey,
            cert: state.certificate,
            clientId: this.device.deviceId,
            reconnectPeriod: 0, // no auto-reconnect
            lookup,
        }
        this.mqtt = mqtt.connect(state.mqttServer.replace('ssl', 'mqtts'), options)

        this.mqtt.on('message', (topic, message, packet) => {
            try {
                if (topic === this.device.state!.subTopic) {
                    const payload = JSON.parse(message.toString('utf-8')) as ClipPayload & { did?: string }
                    if (payload?.did !== this.device.deviceId || typeof payload.cmd !== 'string') return
                    if (payload.cmd === 'completeProvisioning') {
                        //msgtopic=payload.data.appInfo.publication.message
                        this.mqtt.publish(
                            this.device.state!.pubTopic,
                            JSON.stringify({
                                mid: ++this.mid,
                                did: this.device.deviceId,
                                kind: this.device.meta.modelName,
                                cmd: 'completeProvisioning_ack',
                                rssi: -48,
                                fs: 'idle',
                                data: null,
                                type: 1,
                            }),
                        )
                    } else {
                        payload[applicationFrame] = {
                            payload: Buffer.from(message),
                            qos: packet.qos,
                            retain: packet.retain,
                        }
                        log('bridge', `${this.device.deviceId} <- ${payload.cmd}`)
                        this.emit('packet', payload)
                    }
                }
            } catch (err) {
                console.log(err)
            }
        })

        this.mqtt.on('connect', async () => {
            log('bridge', `${this.device.deviceId} connected`)
            this.emit('ready')
            await this.mqtt.subscribe(this.device.state!.subTopic)
            await this.mqtt.publish(
                this.device.state!.provTopic,
                JSON.stringify({
                    mid: ++this.mid,
                    did: this.device.deviceId,
                    kind: this.device.meta.modelName,
                    cmd: 'preDeploy',
                    rssi: -48,
                    fs: 'idle',
                    data: {
                        appInfo: this.deployAppInfo,
                        platformInfo: this.deployPlatformInfo,
                    } satisfies DeployPayload,
                    type: 0,
                }),
                { qos: 1 },
            )
        })

        this.mqtt.on('close', () => this.emit('close'))
        this.mqtt.on('error', (err) => {
            log('bridge', `Error communicating with ${state.mqttServer}: ${err}`)
            this.emit('error', err)
        })
    }

    send(packet: ClipPayload) {
        const frame = packet[applicationFrame]
        if (frame) {
            this.mqtt.publish(this.device.state!.pubTopic, frame.payload, { qos: 0, retain: false })
            return
        }
        log('bridge', `${this.device.deviceId} -> ${format(packet)}`)
        this.mqtt.publish(
            this.device.state!.pubTopic,
            JSON.stringify({
                rssi: -48, // may be overwritten with a real RSSI value from `packet` - which may carry extra fields on top of ClipPayload
                fs: 'idle',
                ...packet,
                mid: ++this.mid,
                did: this.device.deviceId,
                kind: this.device.meta.modelName,
            }),
        )
    }

    destroy() {
        this.mqtt.end()
    }
}
