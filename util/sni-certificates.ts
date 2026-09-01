import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSecureContext, type SecureContext, type TlsOptions } from 'node:tls'
import type { CA } from './config'

const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function normalizeServerName(serverName: string) {
    return serverName.trim().toLowerCase().replace(/\.$/, '')
}

export function validateServerName(serverName: string) {
    const hostname = normalizeServerName(serverName)
    if (!DNS_NAME.test(hostname)) throw new Error('Invalid TLS SNI hostname')
    return hostname
}

export type OpenSSLRunner = (args: string[]) => void

export const runOpenSSL: OpenSSLRunner = (args) => {
    const result = spawnSync('openssl', args, { encoding: 'utf-8' })
    if (result.error) throw new Error(`Unable to start openssl: ${result.error.message}`)
    if (result.status !== 0) {
        const diagnostic = result.stderr.trim().slice(0, 512)
        throw new Error(
            `openssl certificate generation failed (${result.status})${diagnostic ? `: ${diagnostic}` : ''}`,
        )
    }
}

export function certificateExtensions(hostname: string) {
    return [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=DNS:${hostname}`,
        '',
    ].join('\n')
}

export type LeafCertificate = {
    key: string
    cert: string
    context: SecureContext
}

type GenerationDependencies = {
    run?: OpenSSLRunner
    createTempDirectory?: () => string
    cleanupTempDirectory?: (path: string) => void
}

export function generateLeafCertificate(
    ca: CA,
    serverName: string,
    dependencies: GenerationDependencies = {},
): LeafCertificate {
    const hostname = validateServerName(serverName)
    const run = dependencies.run ?? runOpenSSL
    const createTempDirectory = dependencies.createTempDirectory ?? (() => mkdtempSync(join(tmpdir(), 'rethink-sni-')))
    const cleanupTempDirectory =
        dependencies.cleanupTempDirectory ?? ((path) => rmSync(path, { recursive: true, force: true }))
    const dir = createTempDirectory()

    try {
        const caKey = join(dir, 'ca-key.pem')
        const caCert = join(dir, 'ca-cert.pem')
        const leafKey = join(dir, 'leaf-key.pem')
        const leafCsr = join(dir, 'leaf.csr')
        const leafCert = join(dir, 'leaf-cert.pem')
        const extensions = join(dir, 'extensions.cnf')

        writeFileSync(caKey, ca.key, { mode: 0o600 })
        writeFileSync(caCert, ca.cert, { mode: 0o600 })
        writeFileSync(extensions, certificateExtensions(hostname), { mode: 0o600 })

        run(['genrsa', '-out', leafKey, '2048'])
        run(['req', '-new', '-key', leafKey, '-out', leafCsr, '-subj', `/CN=${hostname}`])
        run([
            'x509',
            '-req',
            '-in',
            leafCsr,
            '-CA',
            caCert,
            '-CAkey',
            caKey,
            '-set_serial',
            `0x${randomBytes(16).toString('hex')}`,
            '-out',
            leafCert,
            '-days',
            '825',
            '-sha256',
            '-extfile',
            extensions,
        ])

        const key = readFileSync(leafKey, 'utf-8')
        const cert = readFileSync(leafCert, 'utf-8')
        const leaf = new X509Certificate(cert)
        const issuer = new X509Certificate(ca.cert)
        if (!leaf.checkHost(hostname)) throw new Error(`Generated certificate does not cover ${hostname}`)
        if (leaf.ca) throw new Error(`Generated certificate for ${hostname} is incorrectly marked as a CA`)
        if (!leaf.verify(issuer.publicKey))
            throw new Error(`Generated certificate for ${hostname} is not signed by the configured CA`)

        return { key, cert, context: createSecureContext({ key, cert }) }
    } finally {
        cleanupTempDirectory(dir)
    }
}

type ContextGenerator = (ca: CA, hostname: string) => SecureContext

export class SNICertificateProvider {
    readonly cache = new Map<string, SecureContext>()

    constructor(
        readonly ca: CA,
        readonly generateContext: ContextGenerator = (configuredCA, hostname) =>
            generateLeafCertificate(configuredCA, hostname).context,
    ) {}

    forServerName(serverName: string) {
        const hostname = validateServerName(serverName)
        const cached = this.cache.get(hostname)
        if (cached) return cached

        const generated = this.generateContext(this.ca, hostname)
        this.cache.set(hostname, generated)
        return generated
    }
}

type SNIProvider = Pick<SNICertificateProvider, 'forServerName'>

export function createServerTlsOptions(ca: CA, enabled: boolean, provider?: SNIProvider): TlsOptions {
    if (!enabled) return ca

    const certificateProvider = provider ?? new SNICertificateProvider(ca)
    return {
        ...ca,
        SNICallback: (serverName, callback) => {
            try {
                callback(null, certificateProvider.forServerName(serverName))
            } catch (err) {
                const error = err instanceof Error ? err : new Error('Unknown TLS SNI certificate error')
                console.warn(`TLS SNI certificate selection failed: ${error.message}`)
                callback(error)
            }
        },
    }
}
