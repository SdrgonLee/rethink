import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSecureContext, createServer, connect, type SecureContext } from 'node:tls'
import { after, before, describe, test } from 'node:test'
import { normalize as normalizeConfig, type CA, type RawConfig } from '@/util/config'
import {
    certificateExtensions,
    createServerTlsOptions,
    generateLeafCertificate,
    normalizeServerName,
    runOpenSSL,
    SNICertificateProvider,
    validateServerName,
} from '@/util/sni-certificates'

const DUMMY_CA: CA = { key: 'test-ca-key', cert: 'test-ca-cert' }

function opensslAvailable() {
    const result = spawnSync('openssl', ['version'], { encoding: 'utf-8' })
    return !result.error && result.status === 0
}

const HAS_OPENSSL = opensslAvailable()

describe('SNI hostname policy and cache', () => {
    test('normalizes case, surrounding whitespace and one trailing dot', () => {
        assert.equal(normalizeServerName(' Common.LGThinQ.com. '), 'common.lgthinq.com')
        assert.equal(validateServerName(' Common.LGThinQ.com. '), 'common.lgthinq.com')
    })

    test('rejects invalid hostnames before invoking certificate generation', () => {
        let generations = 0
        const provider = new SNICertificateProvider(DUMMY_CA, () => {
            generations++
            return createSecureContext()
        })

        for (const hostname of ['', '../../etc/passwd', 'hello world', 'a/b.com', 'foo;rm', '-bad.example']) {
            assert.throws(() => provider.forServerName(hostname), /Invalid TLS SNI hostname/)
        }
        assert.equal(generations, 0)
    })

    test('uses one cache entry for equivalent names and separate entries for different names', () => {
        const generated: string[] = []
        const contexts: SecureContext[] = []
        const provider = new SNICertificateProvider(DUMMY_CA, (_ca, hostname) => {
            generated.push(hostname)
            const context = createSecureContext()
            contexts.push(context)
            return context
        })

        const first = provider.forServerName('Common.LGThinQ.com.')
        const cached = provider.forServerName('common.lgthinq.com')
        const different = provider.forServerName('abc.iot.amazonaws.com')

        assert.equal(first, cached)
        assert.notEqual(first, different)
        assert.deepEqual(generated, ['common.lgthinq.com', 'abc.iot.amazonaws.com'])
        assert.equal(provider.cache.size, 2)
    })

    test('builds CA:FALSE, serverAuth and SAN extensions', () => {
        const extensions = certificateExtensions('common.lgthinq.com')
        assert.match(extensions, /basicConstraints=critical,CA:FALSE/)
        assert.match(extensions, /extendedKeyUsage=serverAuth/)
        assert.match(extensions, /subjectAltName=DNS:common\.lgthinq\.com/)
    })

    test('propagates generation failure, leaves no cache entry and removes temporary material', () => {
        const directory = mkdtempSync(join(tmpdir(), 'rethink-sni-failure-test-'))
        const provider = new SNICertificateProvider(
            DUMMY_CA,
            (ca, hostname) =>
                generateLeafCertificate(ca, hostname, {
                    createTempDirectory: () => directory,
                    run: () => {
                        throw new Error('mocked openssl failure')
                    },
                }).context,
        )

        assert.throws(() => provider.forServerName('common.lgthinq.com'), /mocked openssl failure/)
        assert.equal(provider.cache.size, 0)
        assert.equal(existsSync(directory), false)
    })
})

describe('SNI TLS options', () => {
    test('configuration defaults SNI certificates to disabled', () => {
        const config = normalizeConfig({
            hostname: 'rethink.local',
            homeassistant: {
                mqtt_url: 'mqtt://localhost',
                discovery_prefix: 'homeassistant',
                rethink_prefix: 'rethink',
                mqtt_user: '',
                mqtt_pass: '',
            },
            ca_key_file: 'ca.key',
            ca_cert_file: 'ca.cert',
            https_port: 443,
            mqtts_port: 8883,
            mqtt_port: 1883,
        } satisfies RawConfig)
        assert.equal(config.sni_certificates, false)
    })

    test('feature disabled returns the original default certificate without SNICallback', () => {
        const options = createServerTlsOptions(DUMMY_CA, false)
        assert.equal(options, DUMMY_CA)
        assert.equal(options.SNICallback, undefined)
    })

    test('feature enabled delegates valid SNI and propagates invalid SNI errors', async () => {
        const context = createSecureContext()
        const requested: string[] = []
        const options = createServerTlsOptions(DUMMY_CA, true, {
            forServerName: (hostname) => {
                requested.push(hostname)
                return context
            },
        })
        assert.ok(options.SNICallback)

        const selected = await new Promise<SecureContext>((resolve, reject) =>
            options.SNICallback!('common.lgthinq.com', (err, result) => (err ? reject(err) : resolve(result!))),
        )
        assert.equal(selected, context)
        assert.deepEqual(requested, ['common.lgthinq.com'])

        const strictOptions = createServerTlsOptions(DUMMY_CA, true, new SNICertificateProvider(DUMMY_CA))
        await assert.rejects(
            new Promise<SecureContext>((resolve, reject) =>
                strictOptions.SNICallback!('../../etc/passwd', (err, result) => (err ? reject(err) : resolve(result!))),
            ),
            /Invalid TLS SNI hostname/,
        )
    })
})

describe('OpenSSL SNI certificate integration', { skip: !HAS_OPENSSL && 'openssl is not available on PATH' }, () => {
    let directory: string
    let ca: CA

    before(() => {
        directory = mkdtempSync(join(tmpdir(), 'rethink-sni-integration-'))
        const keyPath = join(directory, 'ca.key')
        const certPath = join(directory, 'ca.cert')
        runOpenSSL([
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-keyout',
            keyPath,
            '-out',
            certPath,
            '-sha256',
            '-days',
            '2',
            '-nodes',
            '-subj',
            '/CN=rethink.local',
            '-addext',
            'basicConstraints=critical,CA:TRUE',
            '-addext',
            'keyUsage=critical,keyCertSign,cRLSign',
        ])
        ca = { key: readFileSync(keyPath, 'utf-8'), cert: readFileSync(certPath, 'utf-8') }
    })

    after(() => {
        if (directory) rmSync(directory, { recursive: true, force: true })
    })

    test('generates a SAN leaf signed by the configured CA', () => {
        const generated = generateLeafCertificate(ca, 'common.lgthinq.com')
        const leaf = new X509Certificate(generated.cert)
        const issuer = new X509Certificate(ca.cert)

        assert.equal(leaf.checkHost('common.lgthinq.com'), 'common.lgthinq.com')
        assert.match(leaf.subjectAltName ?? '', /DNS:common\.lgthinq\.com/)
        assert.equal(leaf.ca, false)
        assert.equal(leaf.verify(issuer.publicKey), true)
    })

    test('selects hostname leaves locally and keeps the CA certificate as the no-SNI default', async () => {
        const server = createServer(createServerTlsOptions(ca, true), (socket) => socket.end())
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolve)
        })

        const address = server.address()
        assert.ok(address && typeof address !== 'string')

        async function peerCertificate(servername?: string) {
            return await new Promise<X509Certificate>((resolve, reject) => {
                const socket = connect({
                    host: '127.0.0.1',
                    port: address.port,
                    servername,
                    rejectUnauthorized: false,
                })
                socket.once('secureConnect', () => {
                    const raw = socket.getPeerCertificate().raw
                    socket.end()
                    resolve(new X509Certificate(raw))
                })
                socket.once('error', reject)
            })
        }

        try {
            assert.equal(
                (await peerCertificate('common.lgthinq.com')).checkHost('common.lgthinq.com'),
                'common.lgthinq.com',
            )
            assert.equal(
                (await peerCertificate('example.iot.amazonaws.com')).checkHost('example.iot.amazonaws.com'),
                'example.iot.amazonaws.com',
            )
            assert.equal((await peerCertificate()).fingerprint256, new X509Certificate(ca.cert).fingerprint256)
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    })
})
