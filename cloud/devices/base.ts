import { type Metadata } from '../thinq'
import type { Connection, DeviceDiscovery } from '../homeassistant'

export default class HADevice {
    config: DeviceDiscovery | undefined

    static config(meta: Metadata, deviceInfo?: object): DeviceDiscovery {
        return {
            availability: [{ topic: '$this/availability' }, { topic: '$rethink/availability' }],
            availability_mode: 'all',
            device: {
                identifiers: '$deviceid',
                manufacturer: 'LG',
                model: meta.modelName,
                sw_version: meta.swVersion,
                ...(deviceInfo || {}),
            },
            origin: {
                name: 'rethink',
                support_url: 'https://github.com/anszom/rethink',
            },
            components: {},
        }
    }

    constructor(
        readonly HA: Connection,
        readonly id: string,
    ) {}

    setConfig(
        config: DeviceDiscovery,
        removedComponents?: Record<string, { platform: string }>,
        refreshedComponents?: Record<string, { platform: string }>,
    ) {
        this.config = config
        if (removedComponents || refreshedComponents) {
            // Device-based MQTT discovery removes a component only after receiving a platform-only
            // update for that component. Send the removal form before the final current config.
            // Components listed in refreshedComponents are present again in the final config; this
            // forces Home Assistant to re-register metadata which is otherwise only applied when an
            // entity is added (notably entity_category), while preserving its unique_id/entity_id.
            this.HA.publishProperty(this.id, 'availability', 'online')
            this.HA.publishConfig(this.id, {
                ...config,
                components: { ...config.components, ...removedComponents, ...refreshedComponents },
            } as unknown as DeviceDiscovery)
        }
        this.publishConfig()
    }

    drop() {
        this.HA.publishProperty(this.id, 'availability', 'offline')
    }

    start() {}

    // HA-side
    publishConfig() {
        if (this.config) {
            this.HA.publishProperty(this.id, 'availability', 'online')
            this.HA.publishConfig(this.id, this.config)
        }
    }

    setProperty(prop: string, mqttValue: string) {
        throw new Error('To be overriden')
    }
}
