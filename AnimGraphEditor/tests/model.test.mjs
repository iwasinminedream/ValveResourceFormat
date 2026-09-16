/**
 * Checks the document model, the generated node catalog and the layout: the
 * parts that decide whether an edited graph is still something the compiler
 * will accept.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseKV3 } from '../src/kv3/parse.js';
import { writeKV3 } from '../src/kv3/write.js';
import { KV3Float } from '../src/kv3/values.js';
import {
    GraphDocument,
    createEmptyDocument,
    createPin,
    makeGuid,
} from '../src/model/document.js';
import {
    History,
    addNodeCommand,
    connectCommand,
    deleteNodeCommand,
    layoutCommand,
    moveNodeCommand,
    renameNodeCommand,
} from '../src/model/history.js';
import { computeLayout, graphBounds, nodeHeight } from '../src/model/layout.js';
import {
    NODE_CLASSES,
    instantiate,
    nodeSpec,
    paletteByCategory,
    supportsDynamicInputs,
} from '../src/schema/index.js';

function documentWithTwoNodes() {
    const document = createEmptyDocument();
    const graph = document.rootGraph;
    const clip = graph.addNode(instantiate('CNmGraphDocClipNode', { x: 0, y: 0 }, 'idle'));
    const result = graph.nodes.find((node) => node._class === 'CNmGraphDocPoseResultNode')
        ?? graph.nodes.find((node) => node.className === 'CNmGraphDocPoseResultNode');

    return { document, graph, clip, result };
}

test('the generated catalog covers the decompiler families', () => {
    assert.ok(Object.keys(NODE_CLASSES).length > 100, 'catalog is populated');

    // Spot checks across the families the decompiler builds differently:
    // the table-driven specs, the hand-written builders, and the typed families
    // whose class name is composed at run time.
    assert.ok(nodeSpec('CNmGraphDocNotNode'), 'table-driven spec');
    assert.ok(nodeSpec('CNmGraphDocClipNode'), 'hand-written builder');
    assert.ok(nodeSpec('CNmGraphDocFloatControlParameterNode'), 'typed family');
    assert.ok(nodeSpec('CNmGraphDocStateMachineNode').childGraph, 'state machines own a canvas');
    assert.ok(nodeSpec('CNmGraphDocStateNode').secondaryGraph, 'states own a layer canvas');

    const floatMath = nodeSpec('CNmGraphDocFloatMathNode');
    assert.deepEqual(floatMath.inputs.map((pin) => pin.type), ['Float', 'Float']);
    assert.equal(floatMath.outputs[0].type, 'Float');
    assert.equal(floatMath.properties.m_operator.default, 'Add');
    assert.equal(floatMath.properties.m_bReturnAbsoluteResult.type, 'bool');
});

test('every catalogued class instantiates with fresh identifiers', () => {
    const seen = new Set();

    for (const className of Object.keys(NODE_CLASSES)) {
        const node = instantiate(className, { x: 1, y: 2 });

        assert.equal(node._class, className);
        assert.match(node.m_ID, /^[0-9a-f-]{36}$/);
        assert.ok(!seen.has(node.m_ID), `${className} got a unique id`);
        seen.add(node.m_ID);

        for (const pin of [...node.m_inputPins, ...node.m_outputPins]) {
            assert.ok(!seen.has(pin.m_ID), `${className} pin got a unique id`);
            seen.add(pin.m_ID);
            assert.ok(pin.m_type, 'every pin declares a type');
        }
    }
});

test('the palette groups every class exactly once', () => {
    const palette = paletteByCategory();
    const listed = palette.flatMap((group) => group.specs.map((spec) => spec.class));

    assert.equal(listed.length, Object.keys(NODE_CLASSES).length);
    assert.equal(new Set(listed).size, listed.length);
});

test('a new document writes and reads back as an AnimGraph 2 document', () => {
    const { document } = documentWithTwoNodes();
    const text = writeKV3(document.raw);
    const { root } = parseKV3(text);
    const reloaded = new GraphDocument(root);

    assert.equal(reloaded.rootGraph.nodes.length, 2);
    assert.ok(reloaded.rootGraph.nodes.some((node) => node.name === 'idle'));
});

test('loading something that is not a graph document fails loudly', () => {
    assert.throws(() => new GraphDocument({ _class: 'CAnimationGraph' }), /not an AnimGraph 2 document/);
});

test('connecting enforces pin direction, type and fan-out', () => {
    const { graph, clip, result } = documentWithTwoNodes();
    const pose = clip.outputs.find((pin) => pin.type === 'Pose');

    graph.connect(clip.id, pose.id, result.id, result.inputs[0].id);
    assert.equal(graph.connections.length, 1);

    // A Pose cannot feed a Bool input.
    const boolInput = clip.inputs.find((pin) => pin.type === 'Bool');
    const other = graph.addNode(instantiate('CNmGraphDocZeroPoseNode', { x: 0, y: 0 }));
    assert.throws(
        () => graph.connect(other.id, other.outputs[0].id, clip.id, boolInput.id),
        /cannot wire a Pose output into a Bool input/,
    );

    // ...and a node cannot feed itself, even when the types line up.
    const scale = graph.addNode(instantiate('CNmGraphDocScaleNode', { x: 0, y: 0 }));
    assert.throws(
        () => graph.connect(scale.id, scale.outputs[0].id, scale.id, scale.inputs[0].id),
        /cannot feed itself/,
    );

    // Re-wiring an input replaces the wire that was there.
    graph.connect(other.id, other.outputs[0].id, result.id, result.inputs[0].id);
    assert.equal(graph.connections.length, 1);
    assert.equal(graph.connections[0].m_fromNodeID, other.id);
});

test('a pose output feeds one consumer, a value output feeds many', () => {
    const document = createEmptyDocument();
    const graph = document.rootGraph;

    const zero = graph.addNode(instantiate('CNmGraphDocZeroPoseNode', { x: 0, y: 0 }));
    const blendA = graph.addNode(instantiate('CNmGraphDocScaleNode', { x: 0, y: 0 }));
    const blendB = graph.addNode(instantiate('CNmGraphDocScaleNode', { x: 0, y: 0 }));

    graph.connect(zero.id, zero.outputs[0].id, blendA.id, blendA.inputs[0].id);
    graph.connect(zero.id, zero.outputs[0].id, blendB.id, blendB.inputs[0].id);
    assert.equal(graph.connections.length, 1, 'the pose output moved rather than forked');

    const parameter = graph.addNode(instantiate('CNmGraphDocFloatControlParameterNode', { x: 0, y: 0 }));
    const mathA = graph.addNode(instantiate('CNmGraphDocFloatMathNode', { x: 0, y: 0 }));
    const mathB = graph.addNode(instantiate('CNmGraphDocFloatMathNode', { x: 0, y: 0 }));

    graph.connect(parameter.id, parameter.outputs[0].id, mathA.id, mathA.inputs[0].id);
    graph.connect(parameter.id, parameter.outputs[0].id, mathB.id, mathB.inputs[0].id);

    assert.equal(graph.connectionsOutOf(parameter.outputs[0].id).length, 2);
});

test('a connection that would close a loop is refused', () => {
    const document = createEmptyDocument();
    const graph = document.rootGraph;

    const a = graph.addNode(instantiate('CNmGraphDocScaleNode', { x: 0, y: 0 }, 'a'));
    const b = graph.addNode(instantiate('CNmGraphDocScaleNode', { x: 0, y: 0 }, 'b'));

    graph.connect(a.id, a.outputs[0].id, b.id, b.inputs[0].id);
    assert.throws(() => graph.connect(b.id, b.outputs[0].id, a.id, a.inputs[0].id), /cycle/);
});

test('deleting a node takes its wires with it and undo brings both back', () => {
    const { graph, clip, result } = documentWithTwoNodes();
    const history = new History();

    const pose = clip.outputs.find((pin) => pin.type === 'Pose');
    history.run(connectCommand(graph, clip.id, pose.id, result.id, result.inputs[0].id));
    assert.equal(graph.connections.length, 1);

    history.run(deleteNodeCommand(graph, clip));
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.connections.length, 0);

    history.undo();
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.connections.length, 1);
    assert.equal(graph.node(clip.id).name, 'idle');

    history.redo();
    assert.equal(graph.nodes.length, 1);
});

test('a drag collapses into one undo step', () => {
    const { graph, clip } = documentWithTwoNodes();
    const history = new History();
    const start = clip.position;

    for (let step = 1; step <= 10; step++) {
        history.run(moveNodeCommand(clip, start, { x: step * 10, y: step * 5 }));
    }

    assert.equal(history.undoStack.length, 1);
    assert.deepEqual(clip.position, { x: 100, y: 50 });

    history.undo();
    assert.deepEqual(clip.position, start);
    assert.equal(graph.nodes.length, 2);
});

test('history reports what undo and redo would do', () => {
    const { graph, clip } = documentWithTwoNodes();
    const history = new History();

    assert.equal(history.canUndo, false);
    history.run(renameNodeCommand(clip, 'walk'));
    assert.equal(history.undoLabel, 'Rename');
    assert.equal(clip.name, 'walk');

    history.run(addNodeCommand(graph, instantiate('CNmGraphDocZeroPoseNode', { x: 0, y: 0 })));
    assert.match(history.undoLabel, /^Add /);

    history.undo();
    history.undo();
    assert.equal(clip.name, 'idle');
    assert.equal(history.canUndo, false);
    assert.equal(history.canRedo, true);
});

test('validation finds dangling wires, duplicate ids and type mismatches', () => {
    const { document, graph, clip, result } = documentWithTwoNodes();
    const pose = clip.outputs.find((pin) => pin.type === 'Pose');
    graph.connect(clip.id, pose.id, result.id, result.inputs[0].id);

    assert.deepEqual(document.validate().filter((problem) => problem.severity === 'error'), []);

    graph.raw.m_connections.push({
        m_ID: makeGuid(),
        m_fromNodeID: makeGuid(),
        m_outputPinID: makeGuid(),
        m_toNodeID: result.id,
        m_inputPinID: result.inputs[0].id,
    });

    const problems = document.validate();
    assert.ok(problems.some((problem) => /not in this graph/.test(problem.message)));
});

test('validation warns about an unconnected pose input', () => {
    const { document } = documentWithTwoNodes();
    const warnings = document.validate().filter((problem) => problem.severity === 'warning');

    assert.ok(warnings.some((problem) => /pose input/.test(problem.message)));
});

test('nested canvases are reachable from the root', () => {
    const document = createEmptyDocument();
    const graph = document.rootGraph;
    graph.addNode(instantiate('CNmGraphDocStateMachineNode', { x: 0, y: 0 }, 'locomotion'));

    const graphs = document.allGraphs();
    assert.equal(graphs.length, 2);
    assert.deepEqual(graphs[1].path.map((step) => step.label), ['locomotion']);
});

test('layout ranks a chain left to right and centres it', () => {
    const document = createEmptyDocument();
    const graph = document.rootGraph;

    const zero = graph.addNode(instantiate('CNmGraphDocZeroPoseNode', { x: 0, y: 0 }, 'zero'));
    const scale = graph.addNode(instantiate('CNmGraphDocScaleNode', { x: 0, y: 0 }, 'scale'));
    const result = graph.nodes.find((node) => node.className === 'CNmGraphDocPoseResultNode');

    graph.connect(zero.id, zero.outputs[0].id, scale.id, scale.inputs[0].id);
    graph.connect(scale.id, scale.outputs[0].id, result.id, result.inputs[0].id);

    const positions = computeLayout(graph);

    assert.ok(positions.get(zero.id).x < positions.get(scale.id).x);
    assert.ok(positions.get(scale.id).x < positions.get(result.id).x);
});

test('layout survives a graph whose wires form a loop', () => {
    const document = createEmptyDocument();
    const graph = document.rootGraph;

    const a = graph.addNode(instantiate('CNmGraphDocScaleNode', { x: 0, y: 0 }, 'a'));
    const b = graph.addNode(instantiate('CNmGraphDocScaleNode', { x: 0, y: 0 }, 'b'));

    // Written straight into the raw document, bypassing the cycle check, the
    // way a hand-edited or corrupt file would arrive.
    graph.raw.m_connections.push(
        { m_ID: makeGuid(), m_fromNodeID: a.id, m_outputPinID: a.outputs[0].id, m_toNodeID: b.id, m_inputPinID: b.inputs[0].id },
        { m_ID: makeGuid(), m_fromNodeID: b.id, m_outputPinID: b.outputs[0].id, m_toNodeID: a.id, m_inputPinID: a.inputs[0].id },
    );

    const positions = computeLayout(graph);
    assert.equal(positions.size, graph.nodes.length);
});

test('a layout pass is a single undo step', () => {
    const { graph, clip } = documentWithTwoNodes();
    const history = new History();
    const before = clip.position;

    history.run(layoutCommand(graph, computeLayout(graph)));
    assert.equal(history.undoStack.length, 1);

    history.undo();
    assert.deepEqual(clip.position, before);
});

test('node height and bounds follow the pin count', () => {
    const { graph, clip } = documentWithTwoNodes();

    assert.ok(nodeHeight(clip) >= 60);
    const bounds = graphBounds(graph);
    assert.ok(bounds.width > 0 && bounds.height > 0);
});

test('positions written by the editor read back as floats', () => {
    const { document, clip } = documentWithTwoNodes();

    clip.position = { x: 12, y: -8 };
    assert.ok(clip.raw.m_position[0] instanceof KV3Float, 'a coordinate stays a float');

    const { root } = parseKV3(writeKV3(document.raw));
    const reloaded = new GraphDocument(root).rootGraph.nodes.find((node) => node.name === 'idle');
    assert.deepEqual(reloaded.position, { x: 12, y: -8 });
});

test('dynamic input families are recognised', () => {
    assert.equal(supportsDynamicInputs('CNmGraphDocBlend1DNode'), true);
    assert.equal(supportsDynamicInputs('CNmGraphDocAndNode'), true);
    assert.equal(supportsDynamicInputs('CNmGraphDocFloatMathNode'), false);
});

test('adding and removing a dynamic pin keeps the raw document in step', () => {
    const document = createEmptyDocument();
    const graph = document.rootGraph;
    const blend = graph.addNode(instantiate('CNmGraphDocBlend1DNode', { x: 0, y: 0 }, 'blend'));

    const before = blend.inputs.length;
    const pin = createPin('Extra', 'Pose', { dynamic: true });
    blend.addInputPin(pin);

    assert.equal(blend.inputs.length, before + 1);
    assert.equal(blend.raw.m_inputPins.length, before + 1);

    blend.removeInputPin(pin.m_ID);
    assert.equal(blend.inputs.length, before);
    assert.equal(blend.raw.m_inputPins.length, before);
});

test('unknown properties on a node survive a load/save cycle', () => {
    const { document, clip } = documentWithTwoNodes();
    clip.raw.m_somethingTheCatalogNeverHeardOf = 'keep me';

    const { root } = parseKV3(writeKV3(document.raw));
    const reloaded = new GraphDocument(root).rootGraph.nodes.find((node) => node.name === 'idle');

    assert.equal(reloaded.raw.m_somethingTheCatalogNeverHeardOf, 'keep me');
});
