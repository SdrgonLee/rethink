/**
 * A ThinQ application message observed on one terminated MQTT session.
 * Source transport metadata is diagnostic context; destinations choose their
 * own topic and delivery policy while forwarding payload intact.
 */
export type BridgeMessage = {
    sourceTopic: string
    qos: 0 | 1 | 2
    retain: boolean
    payload: Buffer
}
