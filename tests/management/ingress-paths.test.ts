import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const html = resolve(import.meta.dirname, '../../html')

test('management UI keeps Home Assistant Ingress path prefixes', () => {
    const index = readFileSync(resolve(html, 'index.html'), 'utf8')
    const panel = readFileSync(resolve(html, 'panel.js'), 'utf8')
    const monitor = readFileSync(resolve(html, 'monitor.js'), 'utf8')

    assert.match(index, /<script src="panel\.js"><\/script>/)
    assert.doesNotMatch(index, /<script src="\/panel\.js"><\/script>/)
    assert.match(panel, /const baseUrl = new URL\(window\.location\)/)
    assert.match(panel, /new WebSocket\(baseUrl \+ 'ws'\)/)
    assert.match(monitor, /new URL\('device', window\.location\.href\)/)

    const ingress = new URL('https://ha.example/api/hassio_ingress/session-token/?unused=1')
    ingress.search = ''
    assert.equal(`${ingress}panel.js`, 'https://ha.example/api/hassio_ingress/session-token/panel.js')
    assert.equal(`${ingress}ws`, 'https://ha.example/api/hassio_ingress/session-token/ws')

    const device = new URL('device', 'https://ha.example/api/hassio_ingress/session-token/monitor?id=washer')
    device.protocol = 'wss:'
    device.search = '?id=washer'
    assert.equal(device.href, 'wss://ha.example/api/hassio_ingress/session-token/device?id=washer')
})
