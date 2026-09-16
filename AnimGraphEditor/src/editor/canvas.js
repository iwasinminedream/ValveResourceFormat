/**
 * The canvas: draws one graph and handles everything done with a mouse.
 *
 * Rendering is immediate-mode on a 2D context, redrawn on demand rather than
 * per frame. Hit testing walks the same geometry the renderer uses, so what the
 * pointer picks is always what is on screen.
 *
 * Gestures:
 *   drag on empty space or middle button   pan
 *   wheel                                  zoom about the pointer
 *   drag a node                            move it (one undo step per drag)
 *   drag from a pin                        draw a wire; drop on a pin to connect
 *   drag from a connected input             detach that wire and re-route it
 *   click a wire                           select it
 *   double-click a node with a sub-graph   descend into it
 */

import { HEADER_HEIGHT, NODE_WIDTH, PIN_HEIGHT, nodeHeight, pinAnchor } from '../model/layout.js';
import { nodeTitle } from '../schema/index.js';

/** Wire and pin colour per value type. */
export const TYPE_COLORS = {
    Pose: '#d8a657',
    Bool: '#e07a7a',
    Float: '#7daea3',
    ID: '#a9b665',
    Vector: '#d3869b',
    Target: '#89b482',
    BoneMask: '#9b8bb4',
};

const CATEGORY_COLORS = {
    Parameter: '#4a5a6a',
    Animation: '#5a4a3a',
    'State Machine': '#4a3a5a',
    'IK & Warp': '#3a4a4a',
    Float: '#3a4550',
    Result: '#3f3f46',
};

const PIN_RADIUS = 4.5;
const PIN_HIT_RADIUS = 9;
const DRAG_THRESHOLD = 4;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;

function colorForType(type) {
    return TYPE_COLORS[type] ?? '#8a8a8a';
}

export class GraphCanvas {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} handlers Callbacks into the app shell.
     */
    constructor(canvas, handlers = {}) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');
        this.handlers = handlers;

        this.graph = null;
        this.offset = { x: 60, y: 60 };
        this.zoom = 1;

        this.selectedNodeIds = new Set();
        this.selectedConnectionId = null;
        this.hover = null;
        this.pendingWire = null;
        this.searchHighlight = '';

        this.gesture = null;

        this.attachEvents();
        this.resize();
    }

    setGraph(graph, { resetView = true } = {}) {
        this.graph = graph;
        this.selectedNodeIds.clear();
        this.selectedConnectionId = null;
        this.pendingWire = null;

        if (resetView) {
            this.fit();
        } else {
            this.draw();
        }
    }

    /* ----------------------------------------------------------------- view */

    resize() {
        const ratio = globalThis.devicePixelRatio ?? 1;
        const rect = this.canvas.getBoundingClientRect();

        this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
        this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
        this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.viewport = { width: rect.width, height: rect.height };
        this.draw();
    }

    toGraphPoint(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (clientX - rect.left - this.offset.x) / this.zoom,
            y: (clientY - rect.top - this.offset.y) / this.zoom,
        };
    }

    /** Frames the whole graph, or resets the view when it is empty. */
    fit() {
        if (!this.graph || this.graph.nodes.length === 0) {
            this.offset = { x: 60, y: 60 };
            this.zoom = 1;
            this.draw();
            return;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const node of this.graph.nodes) {
            const { x, y } = node.position;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + NODE_WIDTH);
            maxY = Math.max(maxY, y + nodeHeight(node));
        }

        const padding = 60;
        const width = maxX - minX + padding * 2;
        const height = maxY - minY + padding * 2;

        this.zoom = Math.min(
            MAX_ZOOM,
            Math.max(MIN_ZOOM, Math.min(this.viewport.width / width, this.viewport.height / height)),
        );
        this.offset = {
            x: (this.viewport.width - (maxX - minX) * this.zoom) / 2 - minX * this.zoom,
            y: (this.viewport.height - (maxY - minY) * this.zoom) / 2 - minY * this.zoom,
        };

        this.draw();
    }

    centreOn(node) {
        this.offset = {
            x: this.viewport.width / 2 - (node.position.x + NODE_WIDTH / 2) * this.zoom,
            y: this.viewport.height / 2 - (node.position.y + nodeHeight(node) / 2) * this.zoom,
        };
        this.draw();
    }

    /* ------------------------------------------------------------ hit tests */

    pinAt(point) {
        if (!this.graph) {
            return null;
        }

        for (let i = this.graph.nodes.length - 1; i >= 0; i--) {
            const node = this.graph.nodes[i];

            for (const pin of [...node.inputs, ...node.outputs]) {
                const anchor = pinAnchor(node, pin);
                if (Math.hypot(anchor.x - point.x, anchor.y - point.y) <= PIN_HIT_RADIUS) {
                    return { node, pin };
                }
            }
        }

        return null;
    }

    nodeAt(point) {
        if (!this.graph) {
            return null;
        }

        for (let i = this.graph.nodes.length - 1; i >= 0; i--) {
            const node = this.graph.nodes[i];
            const { x, y } = node.position;

            if (point.x >= x && point.x <= x + NODE_WIDTH
                && point.y >= y && point.y <= y + nodeHeight(node)) {
                return node;
            }
        }

        return null;
    }

    connectionAt(point) {
        if (!this.graph) {
            return null;
        }

        for (const connection of this.graph.connections) {
            const path = this.connectionPath(connection);
            if (!path) {
                continue;
            }

            this.context.lineWidth = 10 / this.zoom;
            const hit = this.context.isPointInStroke(path, ...this.toScreen(point));
            if (hit) {
                return connection;
            }
        }

        return null;
    }

    toScreen(point) {
        return [point.x * this.zoom + this.offset.x, point.y * this.zoom + this.offset.y];
    }

    /* -------------------------------------------------------------- drawing */

    connectionPath(connection) {
        const fromNode = this.graph.node(connection.m_fromNodeID);
        const toNode = this.graph.node(connection.m_toNodeID);

        if (!fromNode || !toNode) {
            return null;
        }

        const outputPin = fromNode.outputs.find((pin) => pin.id === connection.m_outputPinID);
        const inputPin = toNode.inputs.find((pin) => pin.id === connection.m_inputPinID);

        if (!outputPin || !inputPin) {
            return null;
        }

        return this.wirePath(pinAnchor(fromNode, outputPin), pinAnchor(toNode, inputPin));
    }

    /** A horizontal cubic, the shape every node editor draws for a wire. */
    wirePath(from, to) {
        const path = new Path2D();
        const [sx, sy] = this.toScreen(from);
        const [ex, ey] = this.toScreen(to);
        const slack = Math.max(40, Math.abs(ex - sx) * 0.5) * this.zoom;

        path.moveTo(sx, sy);
        path.bezierCurveTo(sx + slack, sy, ex - slack, ey, ex, ey);
        return path;
    }

    draw() {
        const context = this.context;
        const { width, height } = this.viewport;

        context.clearRect(0, 0, width, height);
        context.fillStyle = '#1d2021';
        context.fillRect(0, 0, width, height);

        this.drawGrid();

        if (!this.graph) {
            return;
        }

        for (const connection of this.graph.connections) {
            this.drawConnection(connection);
        }

        if (this.pendingWire) {
            this.drawPendingWire();
        }

        for (const node of this.graph.nodes) {
            this.drawNode(node);
        }
    }

    drawGrid() {
        const context = this.context;
        const { width, height } = this.viewport;
        const step = 32 * this.zoom;

        if (step < 6) {
            return;
        }

        context.strokeStyle = '#26292b';
        context.lineWidth = 1;
        context.beginPath();

        for (let x = this.offset.x % step; x < width; x += step) {
            context.moveTo(Math.round(x) + 0.5, 0);
            context.lineTo(Math.round(x) + 0.5, height);
        }

        for (let y = this.offset.y % step; y < height; y += step) {
            context.moveTo(0, Math.round(y) + 0.5);
            context.lineTo(width, Math.round(y) + 0.5);
        }

        context.stroke();
    }

    drawConnection(connection) {
        const path = this.connectionPath(connection);
        if (!path) {
            return;
        }

        const fromNode = this.graph.node(connection.m_fromNodeID);
        const pin = fromNode.outputs.find((candidate) => candidate.id === connection.m_outputPinID);
        const selected = connection.m_ID === this.selectedConnectionId;

        this.context.strokeStyle = selected ? '#ffffff' : colorForType(pin?.type);
        this.context.lineWidth = (selected ? 3 : 2) * Math.max(0.6, this.zoom);
        this.context.stroke(path);
    }

    drawPendingWire() {
        const { origin, point, pin } = this.pendingWire;
        const path = pin.isInput ? this.wirePath(point, origin) : this.wirePath(origin, point);

        this.context.save();
        this.context.setLineDash([6, 4]);
        this.context.strokeStyle = colorForType(pin.type);
        this.context.lineWidth = 2 * Math.max(0.6, this.zoom);
        this.context.stroke(path);
        this.context.restore();
    }

    drawNode(node) {
        const context = this.context;
        const [x, y] = this.toScreen(node.position);
        const width = NODE_WIDTH * this.zoom;
        const height = nodeHeight(node) * this.zoom;

        // Anything wholly off screen costs nothing to skip.
        if (x + width < 0 || y + height < 0 || x > this.viewport.width || y > this.viewport.height) {
            return;
        }

        const selected = this.selectedNodeIds.has(node.id);
        const dimmed = this.searchHighlight
            && !`${node.name} ${node.className}`.toLowerCase().includes(this.searchHighlight);

        context.save();
        context.globalAlpha = dimmed ? 0.3 : 1;

        const radius = 6 * this.zoom;
        context.beginPath();
        context.roundRect(x, y, width, height, radius);
        context.fillStyle = '#2b3033';
        context.fill();

        context.beginPath();
        context.roundRect(x, y, width, HEADER_HEIGHT * this.zoom, [radius, radius, 0, 0]);
        context.fillStyle = CATEGORY_COLORS[this.handlers.categoryOf?.(node.className)] ?? '#3c4245';
        context.fill();

        context.lineWidth = selected ? 2 : 1;
        context.strokeStyle = selected ? '#fabd2f' : '#15181a';
        context.beginPath();
        context.roundRect(x, y, width, height, radius);
        context.stroke();

        if (this.zoom > 0.35) {
            this.drawNodeText(node, x, y, width);
            this.drawPins(node);
        }

        context.restore();
    }

    drawNodeText(node, x, y, width) {
        const context = this.context;
        const scale = this.zoom;

        context.fillStyle = '#f2e5bc';
        context.font = `${Math.round(12 * scale)}px system-ui, sans-serif`;
        context.textBaseline = 'middle';

        const title = node.name || nodeTitle(node.className);
        context.fillText(
            this.ellipsis(title, width - 16 * scale),
            x + 8 * scale,
            y + (HEADER_HEIGHT / 2) * scale,
        );

        if (node.raw.m_pChildGraph || node.raw.m_pSecondaryGraph) {
            context.fillStyle = '#d5c4a1';
            context.fillText('▸', x + width - 14 * scale, y + (HEADER_HEIGHT / 2) * scale);
        }
    }

    drawPins(node) {
        const context = this.context;
        const scale = this.zoom;
        context.font = `${Math.round(11 * scale)}px system-ui, sans-serif`;
        context.textBaseline = 'middle';

        const connectedInputs = new Set(
            this.graph.connections.map((connection) => connection.m_inputPinID),
        );

        for (const pin of node.inputs) {
            const anchor = pinAnchor(node, pin);
            const [px, py] = this.toScreen(anchor);
            const hovered = this.hover?.pin === pin;

            context.beginPath();
            context.arc(px, py, PIN_RADIUS * Math.max(0.7, scale), 0, Math.PI * 2);
            context.fillStyle = connectedInputs.has(pin.id) || hovered ? colorForType(pin.type) : '#1d2021';
            context.fill();
            context.strokeStyle = colorForType(pin.type);
            context.lineWidth = hovered ? 2 : 1.2;
            context.stroke();

            context.fillStyle = '#bdae93';
            context.textAlign = 'left';
            context.fillText(this.ellipsis(pin.name, 88 * scale), px + 9 * scale, py);
        }

        for (const pin of node.outputs) {
            const anchor = pinAnchor(node, pin);
            const [px, py] = this.toScreen(anchor);
            const hovered = this.hover?.pin === pin;

            context.beginPath();
            context.arc(px, py, PIN_RADIUS * Math.max(0.7, scale), 0, Math.PI * 2);
            context.fillStyle = colorForType(pin.type);
            context.fill();
            context.strokeStyle = hovered ? '#ffffff' : colorForType(pin.type);
            context.lineWidth = hovered ? 2 : 1.2;
            context.stroke();

            context.fillStyle = '#bdae93';
            context.textAlign = 'right';
            context.fillText(this.ellipsis(pin.name, 88 * scale), px - 9 * scale, py);
        }

        context.textAlign = 'left';
    }

    ellipsis(text, maxWidth) {
        if (maxWidth <= 0) {
            return '';
        }

        if (this.context.measureText(text).width <= maxWidth) {
            return text;
        }

        let cut = text;
        while (cut.length > 1 && this.context.measureText(`${cut}…`).width > maxWidth) {
            cut = cut.slice(0, -1);
        }

        return `${cut}…`;
    }

    /* ------------------------------------------------------------ gestures */

    attachEvents() {
        this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
        this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
        this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
        this.canvas.addEventListener('pointercancel', () => this.cancelGesture());
        this.canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
        this.canvas.addEventListener('dblclick', (event) => this.onDoubleClick(event));
        this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    onPointerDown(event) {
        if (!this.graph) {
            return;
        }

        this.canvas.setPointerCapture(event.pointerId);
        const point = this.toGraphPoint(event.clientX, event.clientY);

        if (event.button === 1 || event.button === 2 || event.altKey) {
            this.gesture = { kind: 'pan', origin: { x: event.clientX, y: event.clientY }, offset: { ...this.offset } };
            return;
        }

        const hitPin = this.pinAt(point);
        if (hitPin) {
            this.startWireGesture(hitPin, point);
            return;
        }

        const hitNode = this.nodeAt(point);
        if (hitNode) {
            if (event.shiftKey) {
                if (this.selectedNodeIds.has(hitNode.id)) {
                    this.selectedNodeIds.delete(hitNode.id);
                } else {
                    this.selectedNodeIds.add(hitNode.id);
                }
            } else if (!this.selectedNodeIds.has(hitNode.id)) {
                this.selectedNodeIds = new Set([hitNode.id]);
            }

            this.selectedConnectionId = null;
            this.handlers.onSelectionChanged?.(this.selection());

            this.gesture = {
                kind: 'move',
                origin: point,
                moved: false,
                starts: new Map(
                    Array.from(this.selectedNodeIds, (id) => [id, this.graph.node(id)?.position]),
                ),
            };

            this.draw();
            return;
        }

        const hitConnection = this.connectionAt(point);
        if (hitConnection) {
            this.selectedConnectionId = hitConnection.m_ID;
            this.selectedNodeIds.clear();
            this.handlers.onSelectionChanged?.(this.selection());
            this.draw();
            return;
        }

        this.selectedNodeIds.clear();
        this.selectedConnectionId = null;
        this.handlers.onSelectionChanged?.(this.selection());
        this.gesture = { kind: 'pan', origin: { x: event.clientX, y: event.clientY }, offset: { ...this.offset } };
        this.draw();
    }

    /**
     * Starting a wire on a connected input detaches the wire that is there, so
     * an input can be re-routed by dragging it away rather than deleting first.
     */
    startWireGesture({ node, pin }, point) {
        if (pin.isInput) {
            const existing = this.graph.connectionsInto(pin.id)[0];

            if (existing) {
                const sourceNode = this.graph.node(existing.m_fromNodeID);
                const sourcePin = sourceNode?.outputs.find(
                    (candidate) => candidate.id === existing.m_outputPinID,
                );

                if (sourcePin) {
                    this.handlers.onDisconnect?.(existing);
                    this.pendingWire = {
                        node: sourceNode,
                        pin: sourcePin,
                        origin: pinAnchor(sourceNode, sourcePin),
                        point,
                    };
                    this.gesture = { kind: 'wire' };
                    this.draw();
                    return;
                }
            }
        }

        this.pendingWire = { node, pin, origin: pinAnchor(node, pin), point };
        this.gesture = { kind: 'wire' };
        this.draw();
    }

    onPointerMove(event) {
        const point = this.toGraphPoint(event.clientX, event.clientY);

        if (this.gesture?.kind === 'pan') {
            this.offset = {
                x: this.gesture.offset.x + (event.clientX - this.gesture.origin.x),
                y: this.gesture.offset.y + (event.clientY - this.gesture.origin.y),
            };
            this.draw();
            return;
        }

        if (this.gesture?.kind === 'move') {
            const dx = point.x - this.gesture.origin.x;
            const dy = point.y - this.gesture.origin.y;

            if (!this.gesture.moved && Math.hypot(dx, dy) * this.zoom < DRAG_THRESHOLD) {
                return;
            }
            this.gesture.moved = true;

            for (const [nodeId, start] of this.gesture.starts) {
                if (!start) {
                    continue;
                }

                this.handlers.onMoveNode?.(
                    this.graph.node(nodeId),
                    start,
                    { x: Math.round(start.x + dx), y: Math.round(start.y + dy) },
                );
            }

            this.draw();
            return;
        }

        if (this.gesture?.kind === 'wire') {
            this.pendingWire.point = point;
            this.hover = this.pinAt(point);
            this.draw();
            return;
        }

        const hover = this.pinAt(point);
        if (hover !== this.hover) {
            this.hover = hover;
            this.canvas.style.cursor = hover ? 'crosshair' : 'default';
            this.draw();
        }
    }

    onPointerUp(event) {
        if (this.gesture?.kind === 'wire') {
            const point = this.toGraphPoint(event.clientX, event.clientY);
            const target = this.pinAt(point);
            const source = this.pendingWire;

            this.pendingWire = null;
            this.gesture = null;

            if (target && target.pin.isInput !== source.pin.isInput) {
                const [output, input] = source.pin.isInput
                    ? [target, source]
                    : [source, target];

                this.handlers.onConnect?.(output.node, output.pin, input.node, input.pin);
            } else if (!target) {
                this.handlers.onWireDroppedOnCanvas?.(source, point);
            }

            this.draw();
            return;
        }

        if (this.gesture?.kind === 'move' && this.gesture.moved) {
            this.handlers.onMoveFinished?.();
        }

        this.gesture = null;
    }

    cancelGesture() {
        this.gesture = null;
        this.pendingWire = null;
        this.draw();
    }

    onWheel(event) {
        event.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const anchorX = event.clientX - rect.left;
        const anchorY = event.clientY - rect.top;

        const before = this.toGraphPoint(event.clientX, event.clientY);
        const factor = Math.exp(-event.deltaY * 0.0015);
        this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));

        this.offset = {
            x: anchorX - before.x * this.zoom,
            y: anchorY - before.y * this.zoom,
        };

        this.draw();
    }

    onDoubleClick(event) {
        const point = this.toGraphPoint(event.clientX, event.clientY);
        const node = this.nodeAt(point);

        if (node) {
            this.handlers.onOpenNode?.(node);
        }
    }

    /* ----------------------------------------------------------- selection */

    selection() {
        return {
            nodes: Array.from(this.selectedNodeIds, (id) => this.graph?.node(id)).filter(Boolean),
            connection: this.selectedConnectionId
                ? this.graph?.connections.find((entry) => entry.m_ID === this.selectedConnectionId) ?? null
                : null,
        };
    }

    selectNode(node, { centre = false } = {}) {
        this.selectedNodeIds = new Set([node.id]);
        this.selectedConnectionId = null;

        if (centre) {
            this.centreOn(node);
        } else {
            this.draw();
        }

        this.handlers.onSelectionChanged?.(this.selection());
    }

    setSearchHighlight(query) {
        this.searchHighlight = (query ?? '').trim().toLowerCase();
        this.draw();
    }
}
