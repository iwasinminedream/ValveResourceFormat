/**
 * Builds a sample `.vnmgraph` shaped the way NmGraphExtract writes one: control
 * parameters and a virtual parameter parked in the root blend tree, a state
 * machine whose states own their own canvases, entry-override and transition
 * conduits carrying secondary graphs, and a pose result node.
 *
 * It stands in for a decompiled graph in the tests and doubles as the file the
 * editor offers as a starting point. Run with `node tests/fixtures/make-sample.mjs`.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeKV3 } from '../../src/kv3/write.js';
import { KV3Float } from '../../src/kv3/values.js';
import { createPin, makeGuid } from '../../src/model/document.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function vector2(x, y) {
    return [new KV3Float(x), new KV3Float(y)];
}

function node(className, name, { inputs = [], outputs = [], position = [0, 0], ...rest }) {
    return {
        _class: className,
        m_ID: makeGuid(),
        m_name: name,
        m_floatingComment: '',
        m_position: vector2(position[0], position[1]),
        m_inputPins: inputs,
        m_outputPins: outputs,
        ...rest,
    };
}

function flowGraph(nodes, connections, graphType = 'BlendTree') {
    return {
        _class: 'CNmGraphDocFlowGraph',
        m_ID: makeGuid(),
        m_nodes: nodes,
        m_graphType: graphType,
        m_viewOffset: vector2(0, 0),
        m_flViewZoom: new KV3Float(1),
        m_connections: connections,
    };
}

function connect(from, outputIndex, to, inputIndex) {
    return {
        m_ID: makeGuid(),
        m_fromNodeID: from.m_ID,
        m_outputPinID: from.m_outputPins[outputIndex].m_ID,
        m_toNodeID: to.m_ID,
        m_inputPinID: to.m_inputPins[inputIndex].m_ID,
    };
}

/** A state's own blend tree: one clip feeding the state's pose result. */
function stateBlendTree(clipName, resourcePath) {
    const clip = node('CNmGraphDocClipNode', clipName, {
        position: [0, 0],
        inputs: [createPin('Play In Reverse', 'Bool'), createPin('Reset Time', 'Bool')],
        outputs: [createPin('Pose', 'Pose')],
        m_pDefaultVariationData: {
            _class: 'CNmGraphDocClipNode::CData',
            m_resourceName: resourcePath,
        },
        m_overrides: [],
        m_defaultResourceName: '',
        m_bSampleRootMotion: true,
        m_bAllowLooping: true,
        m_graphEvents: [],
    });

    const result = node('CNmGraphDocPoseResultNode', 'result', {
        position: [320, 0],
        inputs: [createPin('Out', 'Pose')],
    });

    return flowGraph([clip, result], [connect(clip, 0, result, 0)]);
}

/** A state's layer canvas: weight, root-motion weight and bone mask inputs. */
function stateLayerGraph() {
    const result = node('CNmGraphDocStateLayerResultNode', 'result', {
        position: [0, 0],
        inputs: [
            createPin('Layer Weight', 'Float'),
            createPin('Root Motion Weight', 'Float'),
            createPin('Bone Mask', 'BoneMask'),
        ],
    });

    return flowGraph([result], [], 'ValueTree');
}

function stateNode(name, clipName, resourcePath) {
    return node('CNmGraphDocStateNode', name, {
        position: [0, 0],
        m_pChildGraph: stateBlendTree(clipName, resourcePath),
        m_pSecondaryGraph: stateLayerGraph(),
        m_type: 'BlendTreeState',
        m_cloneSourceStateID: '00000000-0000-0000-0000-000000000000',
        m_stateEvents: [],
        m_timedStateEvents: [],
        m_events: [],
        m_entryEvents: [],
        m_executeEvents: [],
        m_exitEvents: [],
        m_timeRemainingEvents: [],
        m_timeElapsedEvents: [],
        m_bUseActualElapsedTimeInStateForTimedEvents: false,
    });
}

export function buildSampleDocument() {
    const idle = stateNode('idle', 'idle_clip', 'animations/idle.vnmclip');
    const run = stateNode('run', 'run_clip', 'animations/run.vnmclip');

    // Transition conduit: idle -> run, gated on a bool control parameter.
    const transitionResult = node('CNmGraphDocTransitionNode', '', {
        position: [320, 0],
        inputs: [createPin('Condition', 'Bool'), createPin('Duration Override', 'Float')],
        m_endStateID: run.m_ID,
        m_bCanBeForced: false,
    });

    const conditionReference = node('CNmGraphDocBoolParameterReferenceNode', 'is_moving', {
        position: [0, 0],
        outputs: [createPin('Value', 'Bool', { allowMultiple: true })],
        m_parameterID: 'is_moving',
    });

    const conduit = node('CNmGraphDocTransitionConduitNode', '', {
        position: [280, 140],
        m_startStateID: idle.m_ID,
        m_endStateID: run.m_ID,
        m_pSecondaryGraph: flowGraph(
            [conditionReference, transitionResult],
            [connect(conditionReference, 0, transitionResult, 0)],
            'TransitionConduit',
        ),
    });

    const entryOverride = node('CNmGraphDocEntryStateOverrideConduitNode', '', {
        position: [280, 260],
        m_pSecondaryGraph: flowGraph(
            [
                node('CNmGraphDocEntryStateOverrideConditionsNode', 'entry overrides', {
                    position: [0, 0],
                    inputs: [
                        createPin('idle', 'Bool', { dynamic: true }),
                        createPin('run', 'Bool', { dynamic: true }),
                    ],
                    m_pinToStateMapping: [idle.m_ID, run.m_ID],
                }),
            ],
            [],
            'EntryOverrideTree',
        ),
    });

    const stateMachineGraph = {
        _class: 'CNmGraphDocStateMachineGraph',
        m_ID: makeGuid(),
        m_nodes: [idle, run, entryOverride, conduit],
        m_graphType: 'StateMachine',
        m_viewOffset: vector2(0, 0),
        m_flViewZoom: new KV3Float(1),
        m_entryStateID: idle.m_ID,
    };

    const stateMachine = node('CNmGraphDocStateMachineNode', 'locomotion', {
        position: [420, 120],
        outputs: [createPin('Pose', 'Pose')],
        m_pChildGraph: stateMachineGraph,
    });

    const isMoving = node('CNmGraphDocBoolControlParameterNode', 'is_moving', {
        position: [0, 0],
        outputs: [createPin('Value', 'Bool', { allowMultiple: true })],
        m_groupName: '',
        m_dictionaryParameterBinding: '00000000-0000-0000-0000-000000000000',
    });

    const speed = node('CNmGraphDocFloatControlParameterNode', 'speed', {
        position: [0, 120],
        outputs: [createPin('Value', 'Float', { allowMultiple: true })],
        m_groupName: '',
        m_dictionaryParameterBinding: '00000000-0000-0000-0000-000000000000',
    });

    // A virtual parameter: speed clamped, exposed as its own value.
    const clampInner = node('CNmGraphDocFloatClampNode', 'clamp', {
        position: [0, 0],
        inputs: [createPin('Value', 'Float')],
        outputs: [createPin('Result', 'Float', { allowMultiple: true })],
        m_clampRange: { m_flBegin: new KV3Float(0), m_flEnd: new KV3Float(1) },
    });

    const clampResult = node('CNmGraphDocFloatResultNode', 'result', {
        position: [320, 0],
        inputs: [createPin('Out', 'Float')],
    });

    const normalisedSpeed = node('CNmGraphDocFloatVirtualParameterNode', 'normalised_speed', {
        position: [0, 240],
        outputs: [createPin('Value', 'Float', { allowMultiple: true })],
        m_groupName: '',
        m_pChildGraph: flowGraph(
            [clampInner, clampResult],
            [connect(clampInner, 0, clampResult, 0)],
            'VirtualParameterValueTree',
        ),
    });

    const result = node('CNmGraphDocPoseResultNode', 'result', {
        position: [760, 120],
        inputs: [createPin('Out', 'Pose')],
    });

    const rootGraph = flowGraph(
        [isMoving, speed, normalisedSpeed, stateMachine, result],
        [connect(stateMachine, 0, result, 0)],
    );

    return {
        _class: 'CNmGraphDocument',
        m_nVersion: 0,
        m_pRootGraph: rootGraph,
        m_variationHierarchy: {
            m_variations: [
                { m_ID: 'Default', m_parentID: '', m_skeleton: 'models/example.vnmskel' },
            ],
        },
        m_debugParameterSets: [],
        m_dictionaryIDSetIDs: [],
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const target = join(HERE, '..', '..', 'examples', 'sample.vnmgraph');
    writeFileSync(target, writeKV3(buildSampleDocument()), 'utf8');
    console.log(`wrote ${target}`);
}
