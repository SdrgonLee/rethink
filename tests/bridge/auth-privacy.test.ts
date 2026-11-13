import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

test('LG authentication does not log account profile data', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../bridge/thinqApi.ts'), 'utf8')

    assert.doesNotMatch(source, /console\.log\(profile\)/)
    assert.doesNotMatch(source, /profile\.account\.userID/)
})
