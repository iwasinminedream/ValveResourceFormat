/**
 * The authored AnimGraph 2 document model.
 *
 * Wraps the raw `CNmGraphDocument` KV3 tree in something an editor can walk and
 * mutate. Every node keeps its original KV3 object, so properties the catalog
 * does not describe are carried through untouched rather than dropped -- an
 * editor that silently loses fields is worse than no editor at all.
 *
 * Shape, as emitted by NmGraphExtract:
 *
 *   CNmGraphDocument
 *     m_pRootGraph          -> CNmGraphDocFlowGraph
 *     m_variationHierarchy
 *   CNmGraphDocFlowGraph / CNmGraphDocStateMachineGraph
 *     m_ID, m_nodes[], m_graphType, m_viewOffset, m_flViewZoom, m_connections[]
 *     m_entryStateID        (state machine graphs only)
 *   node
 *     _class, m_ID, m_name, m_floatingComment, m_position[2]
 *     m_inputPins[], m_outputPins[]
 *     m_pChildGraph         (state machines, states, virtual parameters)
 *     m_pSecondaryGraph     (state layers, transition conduits)
 *   connection
 *     m_ID, m_fromNodeID, m_outputPinID, m_toNodeID, m_inputPinID
 */

import { KV3Float } from '../kv3/values.js';

export const DOCUMENT_CLASS = 'CNmGraphDocument';
export const FLOW_GRAPH_CLASS = 'CNmGraphDocFlowGraph';
export const STATE_MACHINE_GRAPH_CLASS = 'CNmGraphDocStateMachineGraph';

/** RFC 4122 v4 identifier, the form every `m_ID` in these documents takes. */
export function makeGuid() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readVector2(value) {
    if (!Array.isArray(value) || value.length < 2) {
        return { x: 0, y: 0 };
    }

    return { x: Number(value[0]) || 0, y: Number(value[1]) || 0 };
}

function writeVector2(x, y) {
    return [new KV3Float(x), new KV3Float(y)];
}

/** One pin on a node. Backed by the KV3 object so edits land in the document. */
export class Pin {
    constructor(raw, node, isInput) {
        this.raw = raw;
        this.node = node;
        this.isInput = isInput;
    }

    get id() {
        return this.raw.m_ID;
    }

    get name() {
        return this.raw.m_name ?? '';
    }

    set name(value) {
        this.raw.m_name = value;
    }

    get type() {
        return this.raw.m_type ?? 'Pose';
    }

    get isDynamic() {
        return this.raw.m_bIsDynamicPin === true;
    }

    /**
     * Whether an output pin may feed more than one input. Pose outputs are
     * single-consumer; value outputs generally are not.
     */
    get allowsMultiple() {
        return this.raw.m_bAllowMultipleOutConnections === true;
    }
}

export function createPin(name, type, { dynamic = false, allowMultiple = false } = {}) {
    return {
        m_ID: makeGuid(),
        m_name: name,
        m_type: type,
        m_bIsDynamicPin: dynamic,
        m_bAllowMultipleOutConnections: allowMultiple,
    };
}

/** One node on a canvas. */
export class GraphNode {
    constructor(raw, graph) {
        this.raw = raw;
        this.graph = graph;
        this.inputs = (raw.m_inputPins ?? []).map((pin) => new Pin(pin, this, true));
        this.outputs = (raw.m_outputPins ?? []).map((pin) => new Pin(pin, this, false));
    }

    get id() {
        return this.raw.m_ID;
    }

    get className() {
        return this.raw._class;
    }

    get name() {
        return this.raw.m_name ?? '';
    }

    set name(value) {
        this.raw.m_name = value;
    }

    get comment() {
        return this.raw.m_floatingComment ?? '';
    }

    set comment(value) {
        this.raw.m_floatingComment = value;
    }

    get position() {
        return readVector2(this.raw.m_position);
    }

    set position({ x, y }) {
        this.raw.m_position = writeVector2(x, y);
    }

    /** The nested canvas this node owns, if any. */
    get childGraph() {
        return this.raw.m_pChildGraph ? new Graph(this.raw.m_pChildGraph, this) : null;
    }

    /** The second nested canvas some nodes own (state layers, conduits). */
    get secondaryGraph() {
        return this.raw.m_pSecondaryGraph ? new Graph(this.raw.m_pSecondaryGraph, this) : null;
    }

    findPin(pinId) {
        return this.inputs.find((pin) => pin.id === pinId)
            ?? this.outputs.find((pin) => pin.id === pinId)
            ?? null;
    }

    /** Properties outside the structural keys, i.e. what an inspector edits. */
    properties() {
        const structural = new Set([
            '_class', 'm_ID', 'm_name', 'm_floatingComment', 'm_position',
            'm_inputPins', 'm_outputPins', 'm_pChildGraph', 'm_pSecondaryGraph',
        ]);

        return Object.entries(this.raw).filter(([key]) => !structural.has(key));
    }

    addInputPin(pin) {
        this.raw.m_inputPins ??= [];
        this.raw.m_inputPins.push(pin);
        const wrapped = new Pin(pin, this, true);
        this.inputs.push(wrapped);
        return wrapped;
    }

    removeInputPin(pinId) {
        const index = this.inputs.findIndex((pin) => pin.id === pinId);
        if (index < 0) {
            return false;
        }

        this.inputs.splice(index, 1);
        this.raw.m_inputPins.splice(index, 1);
        return true;
    }
}

/** One canvas: a flow graph or a state machine graph. */
export class Graph {
    constructor(raw, owner = null) {
        this.raw = raw;
        this.owner = owner;
        this.nodes = (raw.m_nodes ?? []).map((node) => new GraphNode(node, this));
        this.nodesById = new Map(this.nodes.map((node) => [node.id, node]));
    }

    get id() {
        return this.raw.m_ID;
    }

    get graphType() {
        return this.raw.m_graphType ?? 'BlendTree';
    }

    get isStateMachine() {
        return this.raw._class === STATE_MACHINE_GRAPH_CLASS;
    }

    /** A state machine graph names its entry state instead of holding wires. */
    get entryStateId() {
        return this.raw.m_entryStateID ?? null;
    }

    set entryStateId(value) {
        this.raw.m_entryStateID = value;
    }

    get connections() {
        return this.raw.m_connections ?? [];
    }

    get viewOffset() {
        return readVector2(this.raw.m_viewOffset);
    }

    set viewOffset({ x, y }) {
        this.raw.m_viewOffset = writeVector2(x, y);
    }

    get viewZoom() {
        return Number(this.raw.m_flViewZoom ?? 1) || 1;
    }

    set viewZoom(value) {
        this.raw.m_flViewZoom = new KV3Float(value);
    }

    node(nodeId) {
        return this.nodesById.get(nodeId) ?? null;
    }

    /** Resolves a pin id to its owning node without knowing which node that is. */
    findPin(pinId) {
        for (const node of this.nodes) {
            const pin = node.findPin(pinId);
            if (pin) {
                return pin;
            }
        }

        return null;
    }

    addNode(raw) {
        this.raw.m_nodes ??= [];
        this.raw.m_nodes.push(raw);
        const node = new GraphNode(raw, this);
        this.nodes.push(node);
        this.nodesById.set(node.id, node);
        return node;
    }

    removeNode(nodeId) {
        const index = this.nodes.findIndex((node) => node.id === nodeId);
        if (index < 0) {
            return null;
        }

        const [node] = this.nodes.splice(index, 1);
        this.raw.m_nodes.splice(index, 1);
        this.nodesById.delete(nodeId);

        this.raw.m_connections = this.connections.filter(
            (connection) => connection.m_fromNodeID !== nodeId && connection.m_toNodeID !== nodeId,
        );

        return node;
    }

    connectionsInto(pinId) {
        return this.connections.filter((connection) => connection.m_inputPinID === pinId);
    }

    connectionsOutOf(pinId) {
        return this.connections.filter((connection) => connection.m_outputPinID === pinId);
    }

    /**
     * Wires an output pin to an input pin.
     *
     * Enforces the rules the compiled format assumes: matching value types, one
     * wire per input, and a single consumer for an output that does not opt into
     * fan-out. Returns the new connection, or throws with the reason.
     */
    connect(fromNodeId, outputPinId, toNodeId, inputPinId) {
        const fromNode = this.node(fromNodeId);
        const toNode = this.node(toNodeId);

        if (!fromNode || !toNode) {
            throw new Error('connection endpoint is not in this graph');
        }

        const outputPin = fromNode.outputs.find((pin) => pin.id === outputPinId);
        const inputPin = toNode.inputs.find((pin) => pin.id === inputPinId);

        if (!outputPin) {
            throw new Error('source pin is not an output of the source node');
        }

        if (!inputPin) {
            throw new Error('target pin is not an input of the target node');
        }

        if (outputPin.type !== inputPin.type) {
            throw new Error(`cannot wire a ${outputPin.type} output into a ${inputPin.type} input`);
        }

        if (fromNodeId === toNodeId) {
            throw new Error('a node cannot feed itself');
        }

        if (this.wouldCycle(fromNodeId, toNodeId)) {
            throw new Error('that connection would create a cycle');
        }

        // An input takes one wire; re-wiring replaces what was there.
        this.raw.m_connections = this.connections.filter(
            (connection) => connection.m_inputPinID !== inputPinId,
        );

        if (!outputPin.allowsMultiple) {
            this.raw.m_connections = this.connections.filter(
                (connection) => connection.m_outputPinID !== outputPinId,
            );
        }

        const connection = {
            m_ID: makeGuid(),
            m_fromNodeID: fromNodeId,
            m_outputPinID: outputPinId,
            m_toNodeID: toNodeId,
            m_inputPinID: inputPinId,
        };

        this.raw.m_connections.push(connection);
        return connection;
    }

    disconnect(connectionId) {
        const before = this.connections.length;
        this.raw.m_connections = this.connections.filter(
            (connection) => connection.m_ID !== connectionId,
        );
        return this.connections.length !== before;
    }

    /** Whether wiring `from -> to` closes a loop, walking the existing wires. */
    wouldCycle(fromNodeId, toNodeId) {
        const upstream = new Map();
        for (const connection of this.connections) {
            const list = upstream.get(connection.m_toNodeID) ?? [];
            list.push(connection.m_fromNodeID);
            upstream.set(connection.m_toNodeID, list);
        }

        const stack = [fromNodeId];
        const seen = new Set();

        while (stack.length > 0) {
            const current = stack.pop();
            if (current === toNodeId) {
                return true;
            }

            if (seen.has(current)) {
                continue;
            }
            seen.add(current);

            stack.push(...(upstream.get(current) ?? []));
        }

        return false;
    }

    /** Every nested canvas below this one, with the path taken to reach it. */
    *descend(path = []) {
        yield { graph: this, path };

        for (const node of this.nodes) {
            const label = node.name || node.className;

            const child = node.childGraph;
            if (child) {
                yield* child.descend([...path, { node, label, slot: 'child' }]);
            }

            const secondary = node.secondaryGraph;
            if (secondary) {
                yield* secondary.descend([...path, { node, label, slot: 'secondary' }]);
            }
        }
    }
}

/** A whole `.vnmgraph` document. */
export class GraphDocument {
    constructor(raw, header = null) {
        if (raw?._class !== DOCUMENT_CLASS) {
            throw new Error(`not an AnimGraph 2 document: expected ${DOCUMENT_CLASS}, found ${raw?._class ?? 'nothing'}`);
        }

        this.raw = raw;
        this.header = header;
    }

    get version() {
        return this.raw.m_nVersion ?? 0;
    }

    get rootGraph() {
        if (!this.raw.m_pRootGraph) {
            throw new Error('document has no m_pRootGraph');
        }

        return new Graph(this.raw.m_pRootGraph);
    }

    /** Flat list of every canvas in the document, root first. */
    allGraphs() {
        return Array.from(this.rootGraph.descend());
    }

    /**
     * Structural problems a compiler would reject: dangling wires, duplicate
     * identifiers, mismatched pin types, state machines without an entry state.
     */
    validate() {
        const problems = [];
        const seenIds = new Set();

        for (const { graph, path } of this.rootGraph.descend()) {
            const where = path.length === 0 ? 'root' : path.map((step) => step.label).join(' / ');

            if (seenIds.has(graph.id)) {
                problems.push({ severity: 'error', where, message: `duplicate graph id ${graph.id}` });
            }
            seenIds.add(graph.id);

            for (const node of graph.nodes) {
                if (seenIds.has(node.id)) {
                    problems.push({
                        severity: 'error',
                        where,
                        message: `duplicate node id ${node.id} (${node.name || node.className})`,
                    });
                }
                seenIds.add(node.id);

                for (const pin of [...node.inputs, ...node.outputs]) {
                    if (seenIds.has(pin.id)) {
                        problems.push({
                            severity: 'error',
                            where,
                            message: `duplicate pin id ${pin.id} on ${node.name || node.className}`,
                        });
                    }
                    seenIds.add(pin.id);
                }
            }

            if (graph.isStateMachine) {
                const entry = graph.entryStateId;
                if (!entry || !graph.node(entry)) {
                    problems.push({
                        severity: 'error',
                        where,
                        message: 'state machine has no entry state',
                    });
                }
                continue;
            }

            for (const connection of graph.connections) {
                const fromNode = graph.node(connection.m_fromNodeID);
                const toNode = graph.node(connection.m_toNodeID);

                if (!fromNode || !toNode) {
                    problems.push({
                        severity: 'error',
                        where,
                        message: `connection ${connection.m_ID} names a node that is not in this graph`,
                    });
                    continue;
                }

                const outputPin = fromNode.outputs.find((pin) => pin.id === connection.m_outputPinID);
                const inputPin = toNode.inputs.find((pin) => pin.id === connection.m_inputPinID);

                if (!outputPin || !inputPin) {
                    problems.push({
                        severity: 'error',
                        where,
                        message: `connection ${connection.m_ID} names a pin that does not exist`,
                    });
                    continue;
                }

                if (outputPin.type !== inputPin.type) {
                    problems.push({
                        severity: 'error',
                        where,
                        message: `${fromNode.name || fromNode.className} feeds a ${outputPin.type} into a ${inputPin.type} input on ${toNode.name || toNode.className}`,
                    });
                }
            }

            const filled = new Set(graph.connections.map((connection) => connection.m_inputPinID));
            for (const node of graph.nodes) {
                for (const pin of node.inputs) {
                    if (pin.type === 'Pose' && !filled.has(pin.id)) {
                        problems.push({
                            severity: 'warning',
                            where,
                            message: `${node.name || node.className}: pose input '${pin.name}' is not connected`,
                        });
                    }
                }
            }
        }

        return problems;
    }
}

/** Builds an empty document with a root blend tree and a pose result node. */
export function createEmptyDocument() {
    const resultNode = {
        _class: 'CNmGraphDocPoseResultNode',
        m_ID: makeGuid(),
        m_name: 'result',
        m_floatingComment: '',
        m_position: writeVector2(360, 120),
        m_inputPins: [createPin('Out', 'Pose')],
        m_outputPins: [],
    };

    return new GraphDocument({
        _class: DOCUMENT_CLASS,
        m_nVersion: 0,
        m_pRootGraph: {
            _class: FLOW_GRAPH_CLASS,
            m_ID: makeGuid(),
            m_nodes: [resultNode],
            m_graphType: 'BlendTree',
            m_viewOffset: writeVector2(0, 0),
            m_flViewZoom: new KV3Float(1),
            m_connections: [],
        },
        m_variationHierarchy: {
            _class: 'CNmGraphDocVariationHierarchy',
            m_variations: [],
        },
        m_debugParameterSets: [],
        m_dictionaryIDSetIDs: [],
    });
}
