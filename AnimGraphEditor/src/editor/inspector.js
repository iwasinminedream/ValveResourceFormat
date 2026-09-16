/**
 * The property inspector.
 *
 * Controls are generated from the node catalog: the type the decompiler reads a
 * property through decides the control, and a property the catalog does not
 * describe still shows up as raw JSON so nothing is invisible or unreachable.
 */

import { KV3Float, KV3Flagged } from '../kv3/values.js';
import { nodeSpec, propertyEnum } from '../schema/index.js';

export class Inspector {
    /**
     * @param {HTMLElement} root
     * @param {object} handlers
     */
    constructor(root, handlers) {
        this.root = root;
        this.handlers = handlers;
        this.node = null;
    }

    show(node) {
        this.node = node;
        this.render();
    }

    clear() {
        this.node = null;
        this.root.replaceChildren();

        const hint = document.createElement('p');
        hint.className = 'empty';
        hint.textContent = 'Select a node to edit it.';
        this.root.append(hint);
    }

    render() {
        const node = this.node;
        if (!node) {
            this.clear();
            return;
        }

        const spec = nodeSpec(node.className);
        this.root.replaceChildren();

        const heading = document.createElement('h2');
        heading.textContent = spec?.title ?? node.className;
        this.root.append(heading);

        const className = document.createElement('p');
        className.className = 'class-name';
        className.textContent = node.className;
        this.root.append(className);

        if (!spec) {
            const warning = document.createElement('p');
            warning.className = 'warning';
            warning.textContent = 'This class is not in the generated catalog. '
                + 'Its properties are editable as raw values and are preserved on save.';
            this.root.append(warning);
        }

        this.root.append(this.field('Name', this.textControl(node.name, (value) => {
            this.handlers.onRename(node, value);
        })));

        this.root.append(this.field('Comment', this.textControl(node.comment, (value) => {
            this.handlers.onSetProperty(node, 'm_floatingComment', value);
        })));

        const position = document.createElement('p');
        position.className = 'class-name';
        position.textContent = `id ${node.id}`;
        this.root.append(position);

        const properties = node.properties();
        if (properties.length === 0) {
            return;
        }

        const separator = document.createElement('h3');
        separator.textContent = 'Properties';
        this.root.append(separator);

        for (const [key, value] of properties) {
            const descriptor = spec?.properties?.[key];
            this.root.append(this.field(key, this.controlFor(node, key, value, descriptor, spec)));
        }
    }

    field(label, control) {
        const wrapper = document.createElement('label');
        wrapper.className = 'field';

        const caption = document.createElement('span');
        caption.textContent = label;
        wrapper.append(caption, control);
        return wrapper;
    }

    textControl(value, commit) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value ?? '';
        input.addEventListener('input', () => commit(input.value));
        return input;
    }

    controlFor(node, key, value, descriptor, spec) {
        const type = descriptor?.type ?? inferType(value);
        const options = propertyEnum(spec, key);

        if (options && (type === 'string' || typeof value === 'string')) {
            const select = document.createElement('select');

            // The stored value may be outside the known set; keep it selectable
            // rather than silently rewriting the document on first render.
            const values = options.includes(value) ? options : [value, ...options];
            for (const option of values) {
                const element = document.createElement('option');
                element.value = option;
                element.textContent = option;
                element.selected = option === value;
                select.append(element);
            }

            select.addEventListener('change', () => {
                this.handlers.onSetProperty(node, key, select.value);
            });
            return select;
        }

        if (type === 'bool') {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = value === true;
            input.addEventListener('change', () => {
                this.handlers.onSetProperty(node, key, input.checked);
            });
            return input;
        }

        if (type === 'float' || type === 'int') {
            const input = document.createElement('input');
            input.type = 'number';
            input.step = type === 'float' ? 'any' : '1';
            input.value = String(value instanceof KV3Float ? value.value : (value ?? 0));
            input.addEventListener('input', () => {
                const parsed = Number(input.value);
                if (Number.isNaN(parsed)) {
                    return;
                }

                // A float property keeps its float-ness so `1` never becomes an
                // integer literal the compiler reads as a different type.
                this.handlers.onSetProperty(
                    node,
                    key,
                    type === 'float' ? new KV3Float(parsed) : Math.trunc(parsed),
                );
            });
            return input;
        }

        if (type === 'resource' || value instanceof KV3Flagged) {
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'models/example.vmdl';
            input.value = value instanceof KV3Flagged ? value.value : (value ?? '');
            input.addEventListener('input', () => {
                this.handlers.onSetProperty(
                    node,
                    key,
                    value instanceof KV3Flagged ? new KV3Flagged(value.flag, input.value) : input.value,
                );
            });
            return input;
        }

        if (type === 'string' || type === 'guid') {
            return this.textControl(value, (next) => this.handlers.onSetProperty(node, key, next));
        }

        return this.rawControl(node, key, value);
    }

    /**
     * Fallback for arrays and nested objects: the raw KV3 as JSON. Editing is
     * best-effort and only commits when the text parses, so a half-typed edit
     * cannot corrupt the document.
     */
    rawControl(node, key, value) {
        const area = document.createElement('textarea');
        area.rows = 4;
        area.spellcheck = false;
        area.value = stringify(value);

        area.addEventListener('change', () => {
            try {
                this.handlers.onSetProperty(node, key, JSON.parse(area.value));
                area.classList.remove('invalid');
            } catch {
                area.classList.add('invalid');
            }
        });

        return area;
    }
}

function inferType(value) {
    if (typeof value === 'boolean') {
        return 'bool';
    }

    if (value instanceof KV3Float) {
        return 'float';
    }

    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'int' : 'float';
    }

    if (typeof value === 'string') {
        return 'string';
    }

    return 'object';
}

function stringify(value) {
    return JSON.stringify(value, (_key, entry) => {
        if (entry instanceof KV3Float) {
            return entry.value;
        }

        if (entry instanceof KV3Flagged) {
            return entry.value;
        }

        return entry;
    }, 1);
}
