/**
 * Automatic layout for a canvas.
 *
 * A compiled graph carries no canvas coordinates, so a decompiled document
 * arrives with whatever the decompiler guessed. This lays the nodes out the way
 * the graph reads: a layered left-to-right arrangement with the result node on
 * the right, ordered within each layer to keep the wires from crossing.
 *
 * Layered graph drawing in the usual three passes -- rank, order, position.
 */

export const NODE_WIDTH = 210;
export const HEADER_HEIGHT = 30;
export const PIN_HEIGHT = 20;
export const MIN_NODE_HEIGHT = 60;

const LAYER_GAP = 90;
const ROW_GAP = 28;
const ORDERING_PASSES = 6;

/** How tall a node's card is, given how many pins it shows. */
export function nodeHeight(node) {
    const rows = Math.max(node.inputs.length, node.outputs.length);
    return Math.max(MIN_NODE_HEIGHT, HEADER_HEIGHT + rows * PIN_HEIGHT + 12);
}

function buildAdjacency(graph) {
    const upstream = new Map();
    const downstream = new Map();

    for (const node of graph.nodes) {
        upstream.set(node.id, []);
        downstream.set(node.id, []);
    }

    for (const connection of graph.connections) {
        if (!upstream.has(connection.m_toNodeID) || !downstream.has(connection.m_fromNodeID)) {
            continue;
        }

        upstream.get(connection.m_toNodeID).push(connection.m_fromNodeID);
        downstream.get(connection.m_fromNodeID).push(connection.m_toNodeID);
    }

    return { upstream, downstream };
}

/**
 * Assigns each node a layer: the longest path from any node with no inputs.
 * Cycles cannot occur in a valid document, but a malformed one must not hang,
 * so the walk keeps a visiting set and stops at a repeat.
 */
function assignLayers(graph, upstream) {
    const layers = new Map();
    const visiting = new Set();

    function depth(nodeId) {
        if (layers.has(nodeId)) {
            return layers.get(nodeId);
        }

        if (visiting.has(nodeId)) {
            return 0;
        }

        visiting.add(nodeId);

        const parents = upstream.get(nodeId) ?? [];
        const value = parents.length === 0
            ? 0
            : Math.max(...parents.map((parent) => depth(parent) + 1));

        visiting.delete(nodeId);
        layers.set(nodeId, value);
        return value;
    }

    for (const node of graph.nodes) {
        depth(node.id);
    }

    return layers;
}

function median(values) {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Orders the nodes inside each layer by the median position of their
 * neighbours, sweeping forwards and backwards. Cheap, and it removes most
 * crossings in the tree-shaped graphs these documents produce.
 */
function orderLayers(columns, upstream, downstream) {
    const positions = new Map();

    for (const column of columns) {
        column.forEach((nodeId, index) => positions.set(nodeId, index));
    }

    for (let pass = 0; pass < ORDERING_PASSES; pass++) {
        const forward = pass % 2 === 0;
        const order = forward ? columns : [...columns].reverse();
        const neighbours = forward ? upstream : downstream;

        for (const column of order) {
            const keys = new Map();

            for (const nodeId of column) {
                const related = (neighbours.get(nodeId) ?? [])
                    .map((other) => positions.get(other))
                    .filter((value) => value !== undefined);

                keys.set(nodeId, median(related) ?? positions.get(nodeId));
            }

            column.sort((a, b) => keys.get(a) - keys.get(b) || positions.get(a) - positions.get(b));
            column.forEach((nodeId, index) => positions.set(nodeId, index));
        }
    }
}

/**
 * Lays a graph out and returns the positions without applying them, so the
 * caller can route it through the history as one undoable step.
 *
 * @param {import('./document.js').Graph} graph
 * @returns {Map<string, {x: number, y: number}>}
 */
export function computeLayout(graph) {
    const positions = new Map();

    if (graph.nodes.length === 0) {
        return positions;
    }

    // A state machine graph holds states and conduits rather than wires; a
    // simple grid reads better than a layering with nothing to layer on.
    if (graph.isStateMachine) {
        const columns = Math.ceil(Math.sqrt(graph.nodes.length));
        graph.nodes.forEach((node, index) => {
            positions.set(node.id, {
                x: (index % columns) * (NODE_WIDTH + LAYER_GAP),
                y: Math.floor(index / columns) * (MIN_NODE_HEIGHT + ROW_GAP + 40),
            });
        });
        return positions;
    }

    const { upstream, downstream } = buildAdjacency(graph);
    const layers = assignLayers(graph, upstream);

    const maxLayer = Math.max(...layers.values());
    const columns = Array.from({ length: maxLayer + 1 }, () => []);
    for (const node of graph.nodes) {
        columns[layers.get(node.id)].push(node.id);
    }

    orderLayers(columns, upstream, downstream);

    const heights = new Map(graph.nodes.map((node) => [node.id, nodeHeight(node)]));
    const columnHeights = columns.map(
        (column) => column.reduce((total, nodeId) => total + heights.get(nodeId) + ROW_GAP, -ROW_GAP),
    );
    const tallest = Math.max(0, ...columnHeights);

    columns.forEach((column, layerIndex) => {
        let y = (tallest - columnHeights[layerIndex]) / 2;

        for (const nodeId of column) {
            positions.set(nodeId, {
                x: layerIndex * (NODE_WIDTH + LAYER_GAP),
                y,
            });
            y += heights.get(nodeId) + ROW_GAP;
        }
    });

    return positions;
}

/** Bounding box of a laid-out graph, for fitting the view to it. */
export function graphBounds(graph) {
    if (graph.nodes.length === 0) {
        return { x: 0, y: 0, width: 0, height: 0 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of graph.nodes) {
        const { x, y } = node.position;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + NODE_WIDTH);
        maxY = Math.max(maxY, y + nodeHeight(node));
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Where a pin's dot sits, in graph coordinates. */
export function pinAnchor(node, pin) {
    const { x, y } = node.position;
    const list = pin.isInput ? node.inputs : node.outputs;
    const index = list.indexOf(pin);

    return {
        x: pin.isInput ? x : x + NODE_WIDTH,
        y: y + HEADER_HEIGHT + index * PIN_HEIGHT + PIN_HEIGHT / 2,
    };
}
