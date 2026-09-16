/**
 * Checks the KV3 reader and writer against the ValveResourceFormat test corpus:
 * the generic KV3 sample that exercises every value form, and a real authored
 * Valve animation graph. A file that survives parse -> write -> parse unchanged
 * is one the compiler will still accept after an edit.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseKV3 } from '../src/kv3/parse.js';
import { writeKV3 } from '../src/kv3/write.js';
import { KV3Blob, KV3Flagged, KV3Float, KV3MultilineString } from '../src/kv3/values.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VRF_FILES = join(HERE, '..', '..', 'Tests', 'Files');

function fixture(...parts) {
    return readFileSync(join(VRF_FILES, ...parts), 'utf8');
}

/** Structural equality that sees through the value wrappers. */
function normalise(value) {
    if (value instanceof KV3Float) {
        return { float: value.value };
    }

    if (value instanceof KV3Flagged) {
        return { flag: value.flag, value: value.value };
    }

    if (value instanceof KV3MultilineString) {
        return { multiline: value.value };
    }

    if (value instanceof KV3Blob) {
        return { blob: Array.from(value.bytes) };
    }

    if (Array.isArray(value)) {
        return value.map(normalise);
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalise(entry)]));
    }

    return value;
}

test('reads every value form in the generic KV3 sample', () => {
    const { header, root } = parseKV3(fixture('KeyValues', 'KeyValues3_LF.kv3'));

    assert.match(header.encoding, /^text:version\{/);
    assert.equal(root.boolValue, false);
    assert.equal(root.intValue, 128);
    assert.equal(root.doubleValue.value, 64);
    assert.ok(root.doubleValue instanceof KV3Float, 'a decimal literal stays a float');
    assert.equal(root.negativeIntValue, -1337);
    assert.equal(root.negativeDoubleValue.value, -0.1337);
    assert.equal(root.stringValue, 'hello world');
    assert.equal(root['a quoted key with spaces'], 'some cool value');

    assert.ok(root.stringThatIsAResourceReference instanceof KV3Flagged);
    assert.equal(root.stringThatIsAResourceReference.flag, 'resource');
    assert.equal(root.stringThatIsAResourceReference.value, 'particles/items3_fx/star_emblem.vpcf');

    assert.equal(
        root.multiLineStringValue.value,
        'First line of a multi-line string literal.\nSecond line of a multi-line string literal.',
    );

    assert.equal(root.arrayValue.length, 8, 'a trailing comma does not add an element');
    assert.equal(root.arrayValue[0], 1);
    assert.deepEqual(
        root.arrayValue.filter((entry) => entry instanceof KV3Flagged).map((entry) => entry.flag),
        ['resource', 'panorama', 'soundevent', 'subclass', 'entity_name'],
    );

    assert.equal(root.objectValue.n, 5);
    assert.equal(root.arrayOnSingleLine.length, 3);
    assert.equal(root['quoted.key'], 'hello');

    assert.ok(root.binaryBlobValue instanceof KV3Blob);
    assert.equal(
        Buffer.from(root.binaryBlobValue.bytes).toString('utf8'),
        'Hello, this is a test binary blob value!',
    );
});

test('comments never reach the parsed document', () => {
    const { root } = parseKV3(fixture('KeyValues', 'KeyValues3_LF.kv3'));

    assert.ok(!Object.keys(root).some((key) => key.includes('comment')));
});

test('an authored Valve animation graph survives a parse/write round trip', () => {
    const text = fixture('AuthoredInput', 'vrf_all_nodes.vanmgrph');
    const first = parseKV3(text);

    assert.equal(first.root._class, 'CAnimationGraph');
    assert.ok(Array.isArray(first.root.m_nodes));
    assert.ok(first.root.m_nodes.length > 0);

    const second = parseKV3(writeKV3(first.root, first.header));

    assert.deepEqual(normalise(second.root), normalise(first.root));
});

test('the writer keeps floats, ints and empty containers distinguishable', () => {
    const root = {
        _class: 'Example',
        anInt: 3,
        aFloat: new KV3Float(3),
        aFraction: new KV3Float(0.5),
        emptyArray: [],
        emptyObject: {},
        vector: [new KV3Float(0), new KV3Float(1.5)],
        resource: new KV3Flagged('resource', 'models/a.vmdl'),
        quoted: 'say "hi"\n',
    };

    const text = writeKV3(root);

    assert.match(text, /^<!-- kv3 encoding:text:version\{/);
    assert.match(text, /\tanInt = 3\n/);
    assert.match(text, /\taFloat = 3\.0\n/);
    assert.match(text, /\temptyArray = \[ {2}\]\n/);
    assert.match(text, /\tvector = \[ 0\.0, 1\.5 \]\n/);
    assert.match(text, /\tresource = resource:"models\/a\.vmdl"\n/);

    const { root: reparsed } = parseKV3(text);
    assert.deepEqual(normalise(reparsed), normalise(root));
});

test('string escaping round-trips through the writer', () => {
    const { root } = parseKV3(fixture('KeyValues', 'StringEscaping.kv3'));
    const { root: reparsed } = parseKV3(writeKV3(root));

    assert.deepEqual(normalise(reparsed), normalise(root));
});

test('a malformed document reports where it broke', () => {
    assert.throws(
        () => parseKV3('{\n\tfoo = \n}\n'),
        (error) => error.name === 'KV3ParseError' && /line 3/.test(error.message),
    );
});
