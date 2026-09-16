/**
 * Value wrappers for the parts of KeyValues3 that plain JavaScript cannot
 * represent on its own. Everything else round-trips as a native value: objects
 * as plain objects (insertion order is the document order), arrays as arrays,
 * strings as strings, booleans as booleans, `null` as null.
 */

/**
 * A number that was written with a decimal point. KV3 distinguishes `0` from
 * `0.0` and the compiler cares, so the float-ness has to survive a round trip
 * even when the value happens to be integral.
 */
export class KV3Float {
    constructor(value) {
        this.value = Number(value);
    }

    valueOf() {
        return this.value;
    }

    toString() {
        return String(this.value);
    }
}

/** A string carrying a KV3 type prefix, e.g. `resource:"models/foo.vmdl"`. */
export class KV3Flagged {
    constructor(flag, value) {
        this.flag = flag;
        this.value = value;
    }

    toString() {
        return this.value;
    }
}

/** A `#[ ... ]` binary blob, kept as raw bytes. */
export class KV3Blob {
    constructor(bytes) {
        this.bytes = Uint8Array.from(bytes);
    }
}

/** A multi-line `"""..."""` string literal. */
export class KV3MultilineString {
    constructor(value) {
        this.value = value;
    }

    toString() {
        return this.value;
    }
}

/** The `<!-- kv3 ... -->` header line that opens every KV3 text file. */
export class KV3Header {
    constructor(encoding, format) {
        this.encoding = encoding;
        this.format = format;
    }

    toString() {
        return `<!-- kv3 encoding:${this.encoding} format:${this.format} -->`;
    }
}

export const TEXT_ENCODING = 'text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d}';
export const GENERIC_FORMAT = 'generic:version{7412167c-06e9-4698-aff2-e63eb59037e7}';

/** The header ValveResourceFormat writes when it decompiles a graph. */
export function defaultHeader() {
    return new KV3Header(TEXT_ENCODING, GENERIC_FORMAT);
}

/** Unwraps a wrapper to the value an editor control should show. */
export function plain(value) {
    if (value instanceof KV3Float) {
        return value.value;
    }

    if (value instanceof KV3Flagged || value instanceof KV3MultilineString) {
        return value.value;
    }

    return value;
}
