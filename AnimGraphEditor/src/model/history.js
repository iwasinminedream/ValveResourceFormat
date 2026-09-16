/**
 * Undo/redo.
 *
 * Every edit runs through a command that knows how to undo itself. Node moves
 * that land back to back on the same node coalesce, so dragging a node across
 * the canvas costs one undo step rather than one per mouse-move.
 */

export class History {
    constructor(limit = 200) {
        this.limit = limit;
        this.undoStack = [];
        this.redoStack = [];
        this.listeners = new Set();
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        for (const listener of this.listeners) {
            listener(this);
        }
    }

    get canUndo() {
        return this.undoStack.length > 0;
    }

    get canRedo() {
        return this.redoStack.length > 0;
    }

    get undoLabel() {
        return this.undoStack.at(-1)?.label ?? null;
    }

    get redoLabel() {
        return this.redoStack.at(-1)?.label ?? null;
    }

    /**
     * Runs a command and records it.
     *
     * @param {{label: string, do: Function, undo: Function, coalesceKey?: string}} command
     */
    run(command) {
        const result = command.do();

        const previous = this.undoStack.at(-1);
        if (command.coalesceKey && previous?.coalesceKey === command.coalesceKey) {
            // Keep the older undo (it restores the state before the gesture
            // started) but adopt the newer redo.
            previous.do = command.do;
        } else {
            this.undoStack.push(command);
            if (this.undoStack.length > this.limit) {
                this.undoStack.shift();
            }
        }

        this.redoStack.length = 0;
        this.notify();
        return result;
    }

    undo() {
        const command = this.undoStack.pop();
        if (!command) {
            return false;
        }

        command.undo();
        this.redoStack.push(command);
        this.notify();
        return true;
    }

    redo() {
        const command = this.redoStack.pop();
        if (!command) {
            return false;
        }

        command.do();
        this.undoStack.push(command);
        this.notify();
        return true;
    }

    clear() {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.notify();
    }
}

/** Moves a node, coalescing the whole drag into one undo step. */
export function moveNodeCommand(node, from, to) {
    return {
        label: `Move ${node.name || node.className}`,
        coalesceKey: `move:${node.id}`,
        do: () => {
            node.position = to;
        },
        undo: () => {
            node.position = from;
        },
    };
}

export function addNodeCommand(graph, raw) {
    return {
        label: `Add ${raw.m_name || raw._class}`,
        do: () => graph.addNode(raw),
        undo: () => graph.removeNode(raw.m_ID),
    };
}

/** Deletes a node along with the wires that touched it, and restores both. */
export function deleteNodeCommand(graph, node) {
    const index = graph.nodes.indexOf(node);
    const removedConnections = graph.connections.filter(
        (connection) => connection.m_fromNodeID === node.id || connection.m_toNodeID === node.id,
    );

    return {
        label: `Delete ${node.name || node.className}`,
        do: () => graph.removeNode(node.id),
        undo: () => {
            graph.raw.m_nodes.splice(index, 0, node.raw);
            graph.nodes.splice(index, 0, node);
            graph.nodesById.set(node.id, node);
            graph.raw.m_connections.push(...removedConnections);
        },
    };
}

export function connectCommand(graph, fromNodeId, outputPinId, toNodeId, inputPinId) {
    let created = null;
    let replaced = [];

    return {
        label: 'Connect',
        do: () => {
            replaced = graph.connections.filter(
                (connection) => connection.m_inputPinID === inputPinId
                    || connection.m_outputPinID === outputPinId,
            );
            created = graph.connect(fromNodeId, outputPinId, toNodeId, inputPinId);
            return created;
        },
        undo: () => {
            graph.disconnect(created.m_ID);
            for (const connection of replaced) {
                if (!graph.connections.includes(connection)) {
                    graph.raw.m_connections.push(connection);
                }
            }
        },
    };
}

export function disconnectCommand(graph, connection) {
    return {
        label: 'Disconnect',
        do: () => graph.disconnect(connection.m_ID),
        undo: () => {
            graph.raw.m_connections.push(connection);
        },
    };
}

/** Sets one raw KV3 property on a node. */
export function setPropertyCommand(node, key, value, label = undefined) {
    const previous = node.raw[key];

    return {
        label: label ?? `Edit ${key}`,
        coalesceKey: `property:${node.id}:${key}`,
        do: () => {
            node.raw[key] = value;
        },
        undo: () => {
            node.raw[key] = previous;
        },
    };
}

export function renameNodeCommand(node, name) {
    const previous = node.name;

    return {
        label: 'Rename',
        coalesceKey: `rename:${node.id}`,
        do: () => {
            node.name = name;
        },
        undo: () => {
            node.name = previous;
        },
    };
}

/** Applies a whole layout pass as a single undo step. */
export function layoutCommand(graph, positions) {
    const previous = new Map(graph.nodes.map((node) => [node.id, node.position]));

    return {
        label: 'Auto-layout',
        do: () => {
            for (const [nodeId, position] of positions) {
                graph.node(nodeId)?.position && (graph.node(nodeId).position = position);
            }
        },
        undo: () => {
            for (const [nodeId, position] of previous) {
                const node = graph.node(nodeId);
                if (node) {
                    node.position = position;
                }
            }
        },
    };
}

export function addDynamicPinCommand(node, pin) {
    return {
        label: 'Add input pin',
        do: () => node.addInputPin(pin),
        undo: () => node.removeInputPin(pin.m_ID),
    };
}

/** Removes a dynamic input pin and any wire feeding it. */
export function removeDynamicPinCommand(graph, node, pin) {
    const index = node.inputs.findIndex((candidate) => candidate.id === pin.id);
    const raw = node.raw.m_inputPins[index];
    const removedConnections = graph.connections.filter(
        (connection) => connection.m_inputPinID === pin.id,
    );

    return {
        label: 'Remove input pin',
        do: () => {
            node.removeInputPin(pin.id);
            graph.raw.m_connections = graph.connections.filter(
                (connection) => connection.m_inputPinID !== pin.id,
            );
        },
        undo: () => {
            node.raw.m_inputPins.splice(index, 0, raw);
            node.inputs.splice(index, 0, pin);
            graph.raw.m_connections.push(...removedConnections);
        },
    };
}
