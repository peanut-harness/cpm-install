import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CpmSigningProtocol } from '../signing-protocol.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/signing-vectors.json', import.meta.url), 'utf8'));

for (const vector of fixtures.vectors) {
    test(`${vector.kind} matches the shared canonical signing vector`, () => {
        assert.equal(CpmSigningProtocol.canonicalize(vector.kind, vector.fields), vector.canonicalPayload);
        assert.equal(CpmSigningProtocol.verify(vector.kind, vector.fields, vector.signature, fixtures.publicKey.value), true);
    });

    test(`${vector.kind} rejects every signed-field mutation`, () => {
        for (const field of Object.keys(vector.fields)) {
            const value = vector.fields[field];
            const mutated = {
                ...vector.fields,
                [field]: Array.isArray(value) ? [...value, '9.9.9'] : `${value}-tampered`,
            };
            assert.equal(CpmSigningProtocol.verify(vector.kind, mutated, vector.signature, fixtures.publicKey.value), false, field);
        }
    });
}
