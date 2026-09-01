import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { addDeviceToHome, RemoteError } from '@/bridge/thinqApi'
import type { RequestInit } from 'node-fetch'

const BODY = {
    deviceId: 'target-device',
    countryCode: 'KR',
    deviceType: '201',
    modelName: 'TEST_MODEL',
    aliasPrefix: 'Rethink target-d',
    platformType: 'thinq2' as const,
    initDevice: false,
}

describe('ThinQ Home registration recovery policy', () => {
    test('preserve policy refuses an already-registered conflict without a destructive retry', async () => {
        const bodies: unknown[] = []
        const request = async (_url: string, options: RequestInit) => {
            bodies.push(JSON.parse(String(options.body)))
            throw new RemoteError('https://example', '0125', {})
        }

        await assert.rejects(
            addDeviceToHome(request, 'https://example', {}, { ...BODY }, false),
            /refusing initDevice:true recovery/,
        )
        assert.deepEqual(bodies, [{ ...BODY, initDevice: false }])
    })

    test('legacy policy retains the upstream initDevice:true retry', async () => {
        const bodies: unknown[] = []
        const request = async (_url: string, options: RequestInit) => {
            bodies.push(JSON.parse(String(options.body)))
            if (bodies.length === 1) throw new RemoteError('https://example', '0125', {})
            return {}
        }

        await addDeviceToHome(request, 'https://example', {}, { ...BODY }, true)

        assert.deepEqual(bodies, [
            { ...BODY, initDevice: false },
            { ...BODY, initDevice: true },
        ])
    })
})
