/**
 * The editor shell.
 *
 * Owns the open document, the canvas the user is looking at, the breadcrumb
 * into nested graphs, undo/redo and the file in/out. Everything that mutates
 * the document goes through the history so it can be undone.
 */

import { parseKV3 } from '../kv3/parse.js';
import { writeKV3 } from '../kv3/write.js';
import { defaultHeader } from '../kv3/values.js';
import { GraphDocument, createEmptyDocument, createPin } from '../model/document.js';
import {
    History,
    addDynamicPinCommand,
    addNodeCommand,
    connectCommand,
    deleteNodeCommand,
    disconnectCommand,
    layoutCommand,
    moveNodeCommand,
    renameNodeCommand,
    setPropertyCommand,
} from '../model/history.js';
import { computeLayout } from '../model/layout.js';
import { dynamicPinTemplate, instantiate, nodeCategory, supportsDynamicInputs } from '../schema/index.js';
import { GraphCanvas } from './canvas.js';
import { Inspector } from './inspector.js';
import { Palette } from './palette.js';

const AUTOSAVE_KEY = 'animgraph-editor:document';

export class EditorApp {
    constructor(elements) {
        this.elements = elements;
        this.history = new History();
        this.document = null;
        this.fileName = 'graph.vnmgraph';
        this.dirty = false;

        /** Path of nodes taken from the root graph down to the open canvas. */
        this.breadcrumb = [];

        this.canvas = new GraphCanvas(elements.canvas, {
            categoryOf: (className) => nodeCategory(className),
            onSelectionChanged: (selection) => this.onSelectionChanged(selection),
            onMoveNode: (node, from, to) => this.history.run(moveNodeCommand(node, from, to)),
            onMoveFinished: () => this.markDirty(),
            onConnect: (fromNode, outputPin, toNode, inputPin) =>
                this.connect(fromNode, outputPin, toNode, inputPin),
            onDisconnect: (connection) => this.disconnect(connection),
            onOpenNode: (node) => this.openNode(node),
        });

        this.palette = new Palette(
            elements.palette,
            elements.paletteSearch,
            (className) => this.addNode(className),
        );

        this.inspector = new Inspector(elements.inspector, {
            onRename: (node, name) => {
                this.history.run(renameNodeCommand(node, name));
                this.markDirty();
                this.canvas.draw();
            },
            onSetProperty: (node, key, value) => {
                this.history.run(setPropertyCommand(node, key, value));
                this.markDirty();
                this.canvas.draw();
            },
        });

        this.history.onChange(() => this.refreshHistoryButtons());
        this.attachEvents();
        this.inspector.clear();
        this.restoreOrCreate();
    }

    /* --------------------------------------------------------------- state */

    get graph() {
        return this.canvas.graph;
    }

    markDirty() {
        this.dirty = true;
        this.refreshStatus();
        this.scheduleAutosave();
    }

    restoreOrCreate() {
        const saved = readAutosave();

        if (saved) {
            try {
                const { header, root } = parseKV3(saved.text);
                this.adoptDocument(new GraphDocument(root, header), saved.fileName, { dirty: true });
                this.setStatus(`Restored unsaved work on ${saved.fileName}.`);
                return;
            } catch {
                // A corrupt autosave must never block the editor from starting.
                clearAutosave();
            }
        }

        this.newDocument();
    }

    newDocument() {
        this.adoptDocument(createEmptyDocument(), 'graph.vnmgraph');
        this.setStatus('New graph. Add nodes from the palette on the left.');
    }

    adoptDocument(document, fileName, { dirty = false } = {}) {
        this.document = document;
        this.fileName = fileName;
        this.dirty = dirty;
        this.history.clear();
        this.breadcrumb = [];

        this.canvas.setGraph(document.rootGraph);
        this.inspector.clear();
        this.renderBreadcrumb();
        this.validate();
        this.refreshStatus();
    }

    /* ---------------------------------------------------------- file in/out */

    async openFile(file) {
        const text = await file.text();

        try {
            const { header, root } = parseKV3(text);
            const document = new GraphDocument(root, header ?? defaultHeader());
            this.adoptDocument(document, file.name);
            this.setStatus(`Opened ${file.name}: ${document.allGraphs().length} canvases.`);
        } catch (error) {
            this.setStatus(`Could not open ${file.name}: ${error.message}`, 'error');
        }
    }

    /** Opens the bundled example, so a first visit has something to look at. */
    async loadSample() {
        if (this.dirty && !confirm('Discard unsaved changes?')) {
            return;
        }

        try {
            const response = await fetch('examples/sample.vnmgraph');
            if (!response.ok) {
                throw new Error(`the sample could not be fetched (HTTP ${response.status})`);
            }

            const { header, root } = parseKV3(await response.text());
            this.adoptDocument(new GraphDocument(root, header), 'sample.vnmgraph');
            this.setStatus('Loaded the example graph. Double-click "locomotion" to go inside it.');
        } catch (error) {
            this.setStatus(`Could not load the sample: ${error.message}`, 'error');
        }
    }

    serialize() {
        return writeKV3(this.document.raw, this.document.header ?? defaultHeader());
    }

    save() {
        const text = this.serialize();
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        const link = window.document.createElement('a');
        link.href = url;
        link.download = this.fileName.endsWith('.vnmgraph') ? this.fileName : `${this.fileName}.vnmgraph`;
        link.click();
        URL.revokeObjectURL(url);

        this.dirty = false;
        clearAutosave();
        this.refreshStatus();
        this.setStatus(`Saved ${link.download}. Compile it with Valve's resourcecompiler.`);
    }

    scheduleAutosave() {
        clearTimeout(this.autosaveTimer);
        this.autosaveTimer = setTimeout(() => {
            try {
                localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
                    fileName: this.fileName,
                    text: this.serialize(),
                }));
            } catch {
                // Storage can be full or blocked; autosave is a convenience.
            }
        }, 1200);
    }

    /* ------------------------------------------------------------- editing */

    addNode(className) {
        if (!this.graph) {
            return;
        }

        // Drop it in the middle of what the user is looking at.
        const centre = this.canvas.toGraphPoint(
            this.elements.canvas.getBoundingClientRect().left + this.canvas.viewport.width / 2,
            this.elements.canvas.getBoundingClientRect().top + this.canvas.viewport.height / 2,
        );

        const raw = instantiate(className, { x: Math.round(centre.x), y: Math.round(centre.y) });
        const node = this.history.run(addNodeCommand(this.graph, raw));

        this.markDirty();
        this.canvas.selectNode(node);
        this.validate();
    }

    connect(fromNode, outputPin, toNode, inputPin) {
        try {
            this.history.run(connectCommand(this.graph, fromNode.id, outputPin.id, toNode.id, inputPin.id));
            this.markDirty();
            this.validate();
            this.setStatus(`Connected ${fromNode.name || fromNode.className} to ${toNode.name || toNode.className}.`);
        } catch (error) {
            this.setStatus(error.message, 'error');
        }
    }

    disconnect(connection) {
        this.history.run(disconnectCommand(this.graph, connection));
        this.markDirty();
        this.validate();
    }

    deleteSelection() {
        const { nodes, connection } = this.canvas.selection();

        if (connection) {
            this.disconnect(connection);
            this.canvas.selectedConnectionId = null;
            this.canvas.draw();
            return;
        }

        for (const node of nodes) {
            this.history.run(deleteNodeCommand(this.graph, node));
        }

        if (nodes.length > 0) {
            this.canvas.selectedNodeIds.clear();
            this.inspector.clear();
            this.markDirty();
            this.validate();
            this.canvas.draw();
        }
    }

    /** Appends an input pin to a node whose input list grows, e.g. a blend space. */
    addDynamicPin() {
        const [node] = this.canvas.selection().nodes;

        if (!node || !supportsDynamicInputs(node.className)) {
            this.setStatus('Select a node that takes a variable number of inputs.', 'error');
            return;
        }

        const template = dynamicPinTemplate(node.className);
        const pin = createPin(`${template.name} ${node.inputs.length + 1}`, template.type, { dynamic: true });

        this.history.run(addDynamicPinCommand(node, pin));
        this.markDirty();
        this.inspector.show(node);
        this.canvas.draw();
    }

    runLayout() {
        if (!this.graph) {
            return;
        }

        this.history.run(layoutCommand(this.graph, computeLayout(this.graph)));
        this.markDirty();
        this.canvas.fit();
        this.setStatus('Laid out the current canvas.');
    }

    /* ---------------------------------------------------------- navigation */

    openNode(node) {
        const child = node.childGraph;
        const secondary = node.secondaryGraph;
        const target = child ?? secondary;

        if (!target) {
            return;
        }

        this.breadcrumb.push({ node, slot: child ? 'child' : 'secondary' });
        this.canvas.setGraph(target);
        this.inspector.clear();
        this.renderBreadcrumb();
        this.refreshStatus();
    }

    /** Re-walks the breadcrumb from the root, so the view survives an undo. */
    navigateTo(depth) {
        this.breadcrumb.length = depth;

        let graph = this.document.rootGraph;
        for (const step of this.breadcrumb) {
            const node = graph.node(step.node.id);
            const next = step.slot === 'child' ? node?.childGraph : node?.secondaryGraph;

            if (!next) {
                // The node was deleted underneath us; stop where we still can.
                this.breadcrumb.length = this.breadcrumb.indexOf(step);
                break;
            }

            graph = next;
        }

        this.canvas.setGraph(graph);
        this.inspector.clear();
        this.renderBreadcrumb();
    }

    renderBreadcrumb() {
        const root = this.elements.breadcrumb;
        root.replaceChildren();

        const entries = [{ label: 'root' }, ...this.breadcrumb.map((step) => ({
            label: `${step.node.name || step.node.className}${step.slot === 'secondary' ? ' (layers)' : ''}`,
        }))];

        entries.forEach((entry, index) => {
            if (index > 0) {
                const separator = window.document.createElement('span');
                separator.className = 'separator';
                separator.textContent = '/';
                root.append(separator);
            }

            const button = window.document.createElement('button');
            button.type = 'button';
            button.textContent = entry.label;
            button.disabled = index === entries.length - 1;
            button.addEventListener('click', () => this.navigateTo(index));
            root.append(button);
        });
    }

    /* ------------------------------------------------------------- reports */

    validate() {
        if (!this.document) {
            return;
        }

        const problems = this.document.validate();
        const root = this.elements.problems;
        root.replaceChildren();

        const errors = problems.filter((problem) => problem.severity === 'error');
        this.elements.problemCount.textContent = errors.length > 0
            ? `${errors.length} error${errors.length === 1 ? '' : 's'}`
            : `${problems.length} note${problems.length === 1 ? '' : 's'}`;
        this.elements.problemCount.classList.toggle('has-errors', errors.length > 0);

        if (problems.length === 0) {
            const clean = window.document.createElement('p');
            clean.className = 'empty';
            clean.textContent = 'No problems found.';
            root.append(clean);
            return;
        }

        for (const problem of problems.slice(0, 200)) {
            const line = window.document.createElement('p');
            line.className = `problem ${problem.severity}`;
            line.textContent = `${problem.where}: ${problem.message}`;
            root.append(line);
        }
    }

    onSelectionChanged({ nodes }) {
        if (nodes.length === 1) {
            this.inspector.show(nodes[0]);
        } else {
            this.inspector.clear();
        }
    }

    setStatus(message, kind = 'info') {
        this.elements.status.textContent = message;
        this.elements.status.className = `status ${kind}`;
    }

    refreshStatus() {
        const nodes = this.graph?.nodes.length ?? 0;
        const wires = this.graph?.connections.length ?? 0;
        this.elements.counts.textContent = `${nodes} nodes, ${wires} wires${this.dirty ? ' • unsaved' : ''}`;
    }

    refreshHistoryButtons() {
        this.elements.undo.disabled = !this.history.canUndo;
        this.elements.redo.disabled = !this.history.canRedo;
        this.elements.undo.title = this.history.undoLabel ? `Undo ${this.history.undoLabel}` : 'Undo';
        this.elements.redo.title = this.history.redoLabel ? `Redo ${this.history.redoLabel}` : 'Redo';
    }

    /* -------------------------------------------------------------- events */

    attachEvents() {
        const { elements } = this;

        elements.open.addEventListener('click', () => elements.fileInput.click());
        elements.fileInput.addEventListener('change', async () => {
            const [file] = elements.fileInput.files;
            if (file) {
                await this.openFile(file);
            }
            elements.fileInput.value = '';
        });

        elements.save.addEventListener('click', () => this.save());
        elements.new.addEventListener('click', () => {
            if (!this.dirty || confirm('Discard unsaved changes?')) {
                clearAutosave();
                this.newDocument();
            }
        });

        elements.undo.addEventListener('click', () => {
            this.history.undo();
            this.afterHistoryMove();
        });
        elements.redo.addEventListener('click', () => {
            this.history.redo();
            this.afterHistoryMove();
        });

        elements.sample.addEventListener('click', () => this.loadSample());

        elements.layout.addEventListener('click', () => this.runLayout());
        elements.fit.addEventListener('click', () => this.canvas.fit());
        elements.addPin.addEventListener('click', () => this.addDynamicPin());

        elements.search.addEventListener('input', () => {
            this.canvas.setSearchHighlight(elements.search.value);
        });

        window.addEventListener('resize', () => this.canvas.resize());

        window.addEventListener('keydown', (event) => this.onKeyDown(event));

        window.addEventListener('beforeunload', (event) => {
            if (this.dirty) {
                event.preventDefault();
                event.returnValue = '';
            }
        });

        // Drag a .vnmgraph anywhere onto the window to open it.
        window.addEventListener('dragover', (event) => event.preventDefault());
        window.addEventListener('drop', async (event) => {
            event.preventDefault();
            const [file] = event.dataTransfer?.files ?? [];
            if (file) {
                await this.openFile(file);
            }
        });
    }

    afterHistoryMove() {
        this.markDirty();
        this.navigateTo(this.breadcrumb.length);
        this.validate();
        this.refreshStatus();
    }

    onKeyDown(event) {
        const target = event.target;
        const typing = target instanceof HTMLInputElement
            || target instanceof HTMLTextAreaElement
            || target instanceof HTMLSelectElement;

        if (typing) {
            return;
        }

        const accel = event.ctrlKey || event.metaKey;

        if (accel && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            if (event.shiftKey) {
                this.history.redo();
            } else {
                this.history.undo();
            }
            this.afterHistoryMove();
            return;
        }

        if (accel && event.key.toLowerCase() === 'y') {
            event.preventDefault();
            this.history.redo();
            this.afterHistoryMove();
            return;
        }

        if (accel && event.key.toLowerCase() === 's') {
            event.preventDefault();
            this.save();
            return;
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            this.deleteSelection();
            return;
        }

        if (event.key === 'f' || event.key === 'F') {
            this.canvas.fit();
            return;
        }

        if (event.key === 'l' || event.key === 'L') {
            this.runLayout();
            return;
        }

        if (event.key === 'Escape') {
            this.canvas.cancelGesture();
        }
    }
}

function readAutosave() {
    try {
        const raw = localStorage.getItem(AUTOSAVE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function clearAutosave() {
    try {
        localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
        // Nothing to do; the editor works without persistence.
    }
}
