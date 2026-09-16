/**
 * A KeyValues3 text reader.
 *
 * Covers the subset Valve's animation graph documents use plus the rest of the
 * text grammar the ValveResourceFormat test corpus exercises: typed string
 * prefixes, multi-line strings, binary blobs, comments and trailing commas.
 */

import {
    KV3Blob,
    KV3Flagged,
    KV3Float,
    KV3Header,
    KV3MultilineString,
} from './values.js';

const HEADER_RE = /^<!--\s*kv3\s+encoding:(\S+)\s+format:(\S+)\s*-->/;

export class KV3ParseError extends Error {
    constructor(message, line, column) {
        super(`${message} (line ${line}, column ${column})`);
        this.name = 'KV3ParseError';
        this.line = line;
        this.column = column;
    }
}

class Reader {
    constructor(text) {
        this.text = text;
        this.index = 0;
    }

    get line() {
        let line = 1;
        for (let i = 0; i < this.index && i < this.text.length; i++) {
            if (this.text[i] === '\n') {
                line++;
            }
        }
        return line;
    }

    get column() {
        const lastBreak = this.text.lastIndexOf('\n', Math.max(0, this.index - 1));
        return this.index - lastBreak;
    }

    fail(message) {
        throw new KV3ParseError(message, this.line, this.column);
    }

    eof() {
        return this.index >= this.text.length;
    }

    peek(offset = 0) {
        return this.text[this.index + offset];
    }

    starts(prefix) {
        return this.text.startsWith(prefix, this.index);
    }

    /** Consumes whitespace and both comment forms. */
    skipTrivia() {
        for (;;) {
            while (!this.eof() && /\s/.test(this.text[this.index])) {
                this.index++;
            }

            if (this.starts('//')) {
                const end = this.text.indexOf('\n', this.index);
                this.index = end < 0 ? this.text.length : end;
                continue;
            }

            if (this.starts('/*')) {
                const end = this.text.indexOf('*/', this.index + 2);
                if (end < 0) {
                    this.fail('unterminated block comment');
                }
                this.index = end + 2;
                continue;
            }

            return;
        }
    }

    expect(character) {
        if (this.peek() !== character) {
            this.fail(`expected '${character}' but found '${this.peek() ?? '<end of file>'}'`);
        }
        this.index++;
    }
}

const ESCAPES = {
    n: '\n',
    t: '\t',
    r: '\r',
    '"': '"',
    "'": "'",
    '\\': '\\',
};

function readQuotedString(reader) {
    reader.expect('"');
    let out = '';

    while (!reader.eof()) {
        const character = reader.text[reader.index];

        if (character === '\\') {
            const next = reader.text[reader.index + 1];
            if (next === undefined) {
                reader.fail('unterminated escape sequence');
            }
            out += ESCAPES[next] ?? `\\${next}`;
            reader.index += 2;
            continue;
        }

        if (character === '"') {
            reader.index++;
            return out;
        }

        out += character;
        reader.index++;
    }

    return reader.fail('unterminated string');
}

function readMultilineString(reader) {
    reader.index += 3;

    // Valve drops the newline that immediately follows the opening quotes.
    if (reader.starts('\r\n')) {
        reader.index += 2;
    } else if (reader.peek() === '\n') {
        reader.index += 1;
    }

    const end = reader.text.indexOf('"""', reader.index);
    if (end < 0) {
        reader.fail('unterminated multi-line string');
    }

    let value = reader.text.slice(reader.index, end);
    reader.index = end + 3;

    // ...and the newline that precedes the closing quotes.
    value = value.replace(/\r?\n$/, '');
    return new KV3MultilineString(value);
}

function readBlob(reader) {
    reader.index += 1;
    reader.expect('[');

    const end = reader.text.indexOf(']', reader.index);
    if (end < 0) {
        reader.fail('unterminated binary blob');
    }

    const body = reader.text.slice(reader.index, end);
    reader.index = end + 1;

    const bytes = [];
    for (const token of body.split(/[\s,]+/)) {
        if (token.length === 0) {
            continue;
        }
        const byte = Number.parseInt(token, 16);
        if (Number.isNaN(byte)) {
            reader.fail(`'${token}' is not a hex byte`);
        }
        bytes.push(byte);
    }

    return new KV3Blob(bytes);
}

const NUMBER_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_+]*/;

function readValue(reader) {
    reader.skipTrivia();

    if (reader.eof()) {
        reader.fail('expected a value');
    }

    const character = reader.peek();

    if (character === '{') {
        return readObject(reader);
    }

    if (character === '[') {
        return readArray(reader);
    }

    if (character === '#') {
        return readBlob(reader);
    }

    if (reader.starts('"""')) {
        return readMultilineString(reader);
    }

    if (character === '"') {
        return readQuotedString(reader);
    }

    const rest = reader.text.slice(reader.index);

    const identifier = IDENTIFIER_RE.exec(rest);
    if (identifier) {
        const word = identifier[0];
        const after = reader.text[reader.index + word.length];

        if (after === ':') {
            reader.index += word.length + 1;
            reader.skipTrivia();
            const inner = reader.starts('"""') ? readMultilineString(reader) : readQuotedString(reader);
            return new KV3Flagged(word, String(inner));
        }

        if (word === 'true' || word === 'false') {
            reader.index += word.length;
            return word === 'true';
        }

        if (word === 'null') {
            reader.index += word.length;
            return null;
        }
    }

    const number = NUMBER_RE.exec(rest);
    if (number) {
        const literal = number[0];
        reader.index += literal.length;

        if (/^[+-]?0[xX]/.test(literal)) {
            return Number.parseInt(literal, 16);
        }

        const value = Number.parseFloat(literal);
        return /[.eE]/.test(literal) ? new KV3Float(value) : value;
    }

    return reader.fail(`unexpected character '${character}'`);
}

function readKey(reader) {
    if (reader.peek() === '"') {
        return readQuotedString(reader);
    }

    const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(reader.text.slice(reader.index));
    if (!match) {
        reader.fail('expected a key');
    }

    reader.index += match[0].length;
    return match[0];
}

function readObject(reader) {
    reader.expect('{');
    const result = {};

    for (;;) {
        reader.skipTrivia();

        if (reader.eof()) {
            reader.fail('unterminated object');
        }

        if (reader.peek() === '}') {
            reader.index++;
            return result;
        }

        const key = readKey(reader);
        reader.skipTrivia();
        reader.expect('=');
        result[key] = readValue(reader);

        reader.skipTrivia();
        if (reader.peek() === ',') {
            reader.index++;
        }
    }
}

function readArray(reader) {
    reader.expect('[');
    const result = [];

    for (;;) {
        reader.skipTrivia();

        if (reader.eof()) {
            reader.fail('unterminated array');
        }

        if (reader.peek() === ']') {
            reader.index++;
            return result;
        }

        result.push(readValue(reader));

        reader.skipTrivia();
        if (reader.peek() === ',') {
            reader.index++;
        }
    }
}

/**
 * Parses KV3 text.
 *
 * @param {string} text Whole file contents, header included.
 * @returns {{header: KV3Header|null, root: object}}
 */
export function parseKV3(text) {
    let body = text;
    let header = null;

    // A byte-order mark survives a round trip through the file picker.
    if (body.charCodeAt(0) === 0xfeff) {
        body = body.slice(1);
    }

    const headerMatch = HEADER_RE.exec(body.trimStart());
    if (headerMatch) {
        header = new KV3Header(headerMatch[1], headerMatch[2]);
        const offset = body.indexOf('-->');
        body = body.slice(offset + 3);
    }

    const reader = new Reader(body);
    reader.skipTrivia();
    const root = readValue(reader);
    reader.skipTrivia();

    if (!reader.eof()) {
        reader.fail('trailing content after the root value');
    }

    return { header, root };
}
