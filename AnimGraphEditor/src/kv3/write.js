/**
 * A KeyValues3 text writer.
 *
 * Matches the layout Valve's tools and ValveResourceFormat both produce: tab
 * indentation, a space either side of `=`, a block opened on the line after its
 * key, trailing commas inside arrays, and scalar-only arrays kept on one line.
 * Staying byte-compatible with that style keeps the diff between an edited
 * graph and its decompiled original limited to what actually changed.
 */

import {
    KV3Blob,
    KV3Flagged,
    KV3Float,
    KV3MultilineString,
    defaultHeader,
} from './values.js';

const ESCAPE_RE = /["\\\n\t\r]/g;
const ESCAPES = {
    '"': '\\"',
    '\\': '\\\\',
    '\n': '\\n',
    '\t': '\\t',
    '\r': '\\r',
};

const BARE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quote(value) {
    return `"${String(value).replace(ESCAPE_RE, (character) => ESCAPES[character])}"`;
}

function formatKey(key) {
    return BARE_KEY_RE.test(key) ? key : quote(key);
}

/**
 * Renders a float so it always reads as a float. KV3 treats `0` and `0.0` as
 * different types, so an integral float keeps its `.0`.
 */
function formatFloat(value) {
    if (!Number.isFinite(value)) {
        return value > 0 ? '1e30' : '-1e30';
    }

    if (Number.isInteger(value) && Math.abs(value) < 1e15) {
        return `${value}.0`;
    }

    return String(value);
}

function isScalar(value) {
    return value === null
        || typeof value === 'boolean'
        || typeof value === 'number'
        || typeof value === 'string'
        || value instanceof KV3Float
        || value instanceof KV3Flagged;
}

function formatScalar(value) {
    if (value === null) {
        return 'null';
    }

    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }

    if (value instanceof KV3Float) {
        return formatFloat(value.value);
    }

    if (typeof value === 'number') {
        return Number.isInteger(value) ? String(value) : formatFloat(value);
    }

    if (value instanceof KV3Flagged) {
        return `${value.flag}:${quote(value.value)}`;
    }

    return quote(value);
}

function writeBlob(blob, indent, out) {
    const pad = '\t'.repeat(indent);
    out.push(`${pad}#[`);

    const hex = Array.from(blob.bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, '0'));
    for (let i = 0; i < hex.length; i += 32) {
        out.push(`${pad}\t${hex.slice(i, i + 32).join(' ')}`);
    }

    out.push(`${pad}]`);
}

function writeValue(value, indent, out) {
    const pad = '\t'.repeat(indent);

    if (value instanceof KV3MultilineString) {
        out.push('"""');
        out.push(value.value);
        out.push('"""');
        return;
    }

    if (value instanceof KV3Blob) {
        writeBlob(value, indent, out);
        return;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            out.push(`${pad}[  ]`);
            return;
        }

        if (value.every(isScalar)) {
            out.push(`${pad}[ ${value.map(formatScalar).join(', ')} ]`);
            return;
        }

        out.push(`${pad}[`);
        for (const entry of value) {
            if (isScalar(entry)) {
                out.push(`${pad}\t${formatScalar(entry)},`);
                continue;
            }

            const nested = [];
            writeValue(entry, indent + 1, nested);
            nested[nested.length - 1] += ',';
            out.push(...nested);
        }
        out.push(`${pad}]`);
        return;
    }

    if (value && typeof value === 'object') {
        out.push(`${pad}{`);
        writeMembers(value, indent + 1, out);
        out.push(`${pad}}`);
        return;
    }

    out.push(`${pad}${formatScalar(value)}`);
}

function writeMembers(object, indent, out) {
    const pad = '\t'.repeat(indent);

    for (const [key, value] of Object.entries(object)) {
        if (value === undefined) {
            continue;
        }

        if (isScalar(value)) {
            out.push(`${pad}${formatKey(key)} = ${formatScalar(value)}`);
            continue;
        }

        if (value instanceof KV3MultilineString) {
            out.push(`${pad}${formatKey(key)} = """`);
            out.push(value.value);
            out.push('"""');
            continue;
        }

        if (Array.isArray(value) && (value.length === 0 || value.every(isScalar))) {
            const inline = [];
            writeValue(value, 0, inline);
            out.push(`${pad}${formatKey(key)} = ${inline.join('')}`);
            continue;
        }

        // Valve's writer leaves the space after `=` before breaking the line.
        out.push(`${pad}${formatKey(key)} = `);
        writeValue(value, indent, out);
    }
}

/**
 * Serializes a value as a KV3 text document.
 *
 * @param {object} root Root object.
 * @param {import('./values.js').KV3Header} [header] Header to write.
 * @returns {string}
 */
export function writeKV3(root, header = defaultHeader()) {
    const out = [header.toString()];
    writeValue(root, 0, out);
    return `${out.join('\n')}\n`;
}
