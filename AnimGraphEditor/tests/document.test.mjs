/**
 * End-to-end checks against a document shaped like real decompiler output:
 * control parameters, a virtual parameter with its own value tree, a state
 * machine whose states each own a blend tree and a layer canvas, and transition
 * and entry-override conduits carrying secondary graphs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseKV3 } from '../src/kv3/parse.js';
import { writeKV3 } from '../src/kv3/write.js';
import { GraphDocument } from '../src/model/document.js';
import { History, deleteNodeCommand, layoutCommand, setPropertyCommand } from '../src/model/history.js';
import { computeLayout } from '../src/model/layout.js';
import { instantiate } from '../src/schema/index.js';
import { buildSampleDocument } from './fixtures/make-sample.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function load() {
    return new GraphDocument(buildSampleDocument());
}

test('the shipped sample file on disk matches what the builder produces', () => {
    const onDisk = readFileSync(join(HERE, '..', 'examples', 'sample.vnmgraph'), 'utf8');
    const { root } = parseKV3(onDisk);
    const document = new GraphDocument(root);

    assert.equal(document.rootGraph.nodes.length, 5);
    assert.equal(document.allGraphs().length, load().allGraphs().length);
});

test('every canvas in a decompiler-shaped document is reachable', () => {
    const graphs = load().allGraphs();

    // root, the state machine, two states' blend trees and layer canvases,
    // the entry-override tree and the transition conduit, plus the virtual
    // parameter's value tree.
    const labels = graphs.map(({ path }) => path.map((step) => step.label).join('/'));

    assert.ok(labels.includes(''), 'the root canvas');
    assert.ok(labels.includes('locomotion'), 'the state machine canvas');
    assert.ok(labels.includes('locomotion/idle'), "a state's blend tree");
    assert.ok(labels.includes('normalised_speed'), "the virtual parameter's value tree");
    assert.equal(graphs.length, 9);
});

test('a decompiler-shaped document validates clean', () => {
    const errors = load().validate().filter((problem) => problem.severity === 'error');

    assert.deepEqual(errors, []);
});

test('a state machine missing its entry state is reported', () => {
    const document = load();
    const stateMachine = document.rootGraph.nodes.find((node) => node.name === 'locomotion');
    stateMachine.raw.m_pChildGraph.m_entryStateID = '';

    const problems = document.validate();
    assert.ok(problems.some((problem) => /no entry state/.test(problem.message)));
});

test('editing inside a nested canvas lands in the saved file', () => {
    const document = load();
    const history = new History();

    const stateMachine = document.rootGraph.node(
        document.rootGraph.nodes.find((node) => node.name === 'locomotion').id,
    );
    const idle = stateMachine.childGraph.nodes.find((node) => node.name === 'idle');
    const clip = idle.childGraph.nodes.find((node) => node.className === 'CNmGraphDocClipNode');

    history.run(setPropertyCommand(clip, 'm_bAllowLooping', false));

    const { root } = parseKV3(writeKV3(document.raw));
    const reloaded = new GraphDocument(root);
    const reloadedClip = reloaded.rootGraph.nodes
        .find((node) => node.name === 'locomotion').childGraph.nodes
        .find((node) => node.name === 'idle').childGraph.nodes
        .find((node) => node.className === 'CNmGraphDocClipNode');

    assert.equal(reloadedClip.raw.m_bAllowLooping, false);

    history.undo();
    assert.equal(clip.raw.m_bAllowLooping, true);
});

test('a full load, edit and save cycle changes only what was edited', () => {
    const original = writeKV3(buildSampleDocument());
    const document = new GraphDocument(parseKV3(original).root);

    const untouched = writeKV3(document.raw);
    assert.equal(untouched, original, 'a load followed by a save is byte-identical');

    const speed = document.rootGraph.nodes.find((node) => node.name === 'speed');
    speed.name = 'movement_speed';

    const edited = writeKV3(document.raw);
    const changedLines = edited.split('\n').filter(
        (line, index) => line !== original.split('\n')[index],
    );

    assert.equal(changedLines.length, 1, 'only the renamed line differs');
    assert.match(changedLines[0], /movement_speed/);
});

test('laying out a nested canvas leaves the rest of the document alone', () => {
    const document = load();
    const history = new History();

    const stateMachine = document.rootGraph.nodes.find((node) => node.name === 'locomotion');
    const before = document.rootGraph.nodes.map((node) => node.position);

    const target = stateMachine.childGraph.nodes
        .find((node) => node.name === 'idle').childGraph;
    history.run(layoutCommand(target, computeLayout(target)));

    assert.deepEqual(document.rootGraph.nodes.map((node) => node.position), before);
});

test('deleting a state takes its canvases with it and undo restores them', () => {
    const document = load();
    const history = new History();

    const stateMachineGraph = document.rootGraph.nodes
        .find((node) => node.name === 'locomotion').childGraph;
    const run = stateMachineGraph.nodes.find((node) => node.name === 'run');

    const graphsBefore = document.allGraphs().length;
    history.run(deleteNodeCommand(stateMachineGraph, run));

    assert.ok(document.allGraphs().length < graphsBefore);

    history.undo();
    assert.equal(document.allGraphs().length, graphsBefore);
    assert.ok(stateMachineGraph.nodes.some((node) => node.name === 'run'));
});

test('a node added to a nested canvas serializes inside that canvas', () => {
    const document = load();
    const idleTree = document.rootGraph.nodes
        .find((node) => node.name === 'locomotion').childGraph.nodes
        .find((node) => node.name === 'idle').childGraph;

    idleTree.addNode(instantiate('CNmGraphDocZeroPoseNode', { x: 40, y: 200 }, 'fallback'));

    const reloaded = new GraphDocument(parseKV3(writeKV3(document.raw)).root);
    const names = reloaded.rootGraph.nodes
        .find((node) => node.name === 'locomotion').childGraph.nodes
        .find((node) => node.name === 'idle').childGraph.nodes
        .map((node) => node.name);

    assert.ok(names.includes('fallback'));
    assert.ok(!document.rootGraph.nodes.some((node) => node.name === 'fallback'));
});

test('conduits and their secondary graphs survive a round trip', () => {
    const document = load();
    const reloaded = new GraphDocument(parseKV3(writeKV3(document.raw)).root);

    const conduit = reloaded.rootGraph.nodes
        .find((node) => node.name === 'locomotion').childGraph.nodes
        .find((node) => node.className === 'CNmGraphDocTransitionConduitNode');

    assert.ok(conduit, 'the transition conduit is still there');
    assert.equal(conduit.secondaryGraph.graphType, 'TransitionConduit');
    assert.equal(conduit.secondaryGraph.connections.length, 1);
});
