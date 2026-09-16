/**
 * The node palette: every class the catalog knows, grouped by category and
 * filtered as you type. Clicking one adds it to the current canvas.
 */

import { paletteByCategory } from '../schema/index.js';

export class Palette {
    /**
     * @param {HTMLElement} root
     * @param {HTMLInputElement} searchInput
     * @param {(className: string) => void} onPick
     */
    constructor(root, searchInput, onPick) {
        this.root = root;
        this.searchInput = searchInput;
        this.onPick = onPick;
        this.groups = paletteByCategory();
        this.query = '';

        this.searchInput.addEventListener('input', () => {
            this.query = this.searchInput.value.trim().toLowerCase();
            this.render();
        });

        this.render();
    }

    matches(spec) {
        if (this.query.length === 0) {
            return true;
        }

        return `${spec.title} ${spec.class} ${(spec.stems ?? []).join(' ')}`
            .toLowerCase()
            .includes(this.query);
    }

    render() {
        this.root.replaceChildren();
        let shown = 0;

        for (const { category, specs } of this.groups) {
            const visible = specs.filter((spec) => this.matches(spec));
            if (visible.length === 0) {
                continue;
            }

            const details = document.createElement('details');
            // Searching should reveal what it found without a second click.
            details.open = this.query.length > 0 || category === 'Animation';

            const summary = document.createElement('summary');
            summary.textContent = `${category} (${visible.length})`;
            details.append(summary);

            for (const spec of visible) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'palette-entry';
                button.textContent = spec.title;
                button.title = `${spec.class}\n${describe(spec)}`;
                button.addEventListener('click', () => this.onPick(spec.class));
                details.append(button);
                shown++;
            }

            this.root.append(details);
        }

        if (shown === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty';
            empty.textContent = 'No node matches that search.';
            this.root.append(empty);
        }
    }
}

function describe(spec) {
    const inputs = spec.inputs.length === 0
        ? 'no inputs'
        : spec.inputs.map((pin) => `${pin.name}: ${pin.type}`).join(', ');
    const outputs = spec.outputs.length === 0
        ? 'no outputs'
        : spec.outputs.map((pin) => `${pin.name}: ${pin.type}`).join(', ');

    return `in  ${inputs}\nout ${outputs}`;
}
