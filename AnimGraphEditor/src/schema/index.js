/**
 * The node catalog: what classes exist, what pins and properties each carries,
 * and how to instantiate one.
 *
 * The data behind this comes from `tools/generate-schema.py`, which reads it out
 * of the ValveResourceFormat decompiler. Nothing here is hand-maintained, so a
 * class the decompiler learns to emit shows up in the palette after a re-run.
 */

import catalog from './nodes.generated.js';
import { createPin, makeGuid } from '../model/document.js';
import { KV3Float } from '../kv3/values.js';

export const VALUE_TYPES = catalog.valueTypes;
export const SOURCE = catalog.source;

/** Every known class, keyed by its `_class` string. */
export const NODE_CLASSES = catalog.nodes;

/** Enum-ish string properties the decompiler writes but cannot enumerate. */
const KNOWN_ENUMS = {
    m_operator: ['Add', 'Sub', 'Mul', 'Div'],
    m_comparison: ['GreaterThan', 'GreaterThanEqual', 'LessThan', 'LessThanEqual', 'Equal', 'NotEqual'],
    m_mode: ['OnEntry', 'OnExit'],
    m_type: ['BlendTreeState', 'StateMachineState', 'OffState'],
    m_infoType: ['Index', 'PercentageThrough'],
};

export function nodeSpec(className) {
    return NODE_CLASSES[className] ?? null;
}

/** Display name for a class, falling back to the raw class for unknown nodes. */
export function nodeTitle(className) {
    return nodeSpec(className)?.title ?? className;
}

export function nodeCategory(className) {
    return nodeSpec(className)?.category ?? 'Other';
}

/** The palette, grouped by category and sorted for stable presentation. */
export function paletteByCategory() {
    const groups = new Map();

    for (const spec of Object.values(NODE_CLASSES)) {
        const group = groups.get(spec.category) ?? [];
        group.push(spec);
        groups.set(spec.category, group);
    }

    return Array.from(groups, ([category, specs]) => ({
        category,
        specs: specs.sort((a, b) => a.title.localeCompare(b.title)),
    })).sort((a, b) => a.category.localeCompare(b.category));
}

/** Candidate enum values for a property, or null when it is free text. */
export function propertyEnum(spec, key) {
    return spec?.properties?.[key]?.enum ?? KNOWN_ENUMS[key] ?? null;
}

function defaultValue(descriptor) {
    switch (descriptor.type) {
        case 'bool':
            return descriptor.default ?? false;
        case 'float':
            return new KV3Float(descriptor.default ?? 0);
        case 'int':
            return descriptor.default ?? 0;
        case 'string':
        case 'resource':
        case 'guid':
            return descriptor.default ?? '';
        case 'array':
            return [];
        case 'vector':
            return [new KV3Float(0), new KV3Float(0)];
        default:
            return descriptor.default ?? null;
    }
}

/**
 * Builds a fresh node of `className` as a raw KV3 object, ready to be added to
 * a graph. Pins get new identifiers; properties get the defaults the decompiler
 * writes when the compiled graph does not say otherwise.
 *
 * @param {string} className
 * @param {{x: number, y: number}} position
 * @param {string} [name]
 */
export function instantiate(className, position = { x: 0, y: 0 }, name = undefined) {
    const spec = nodeSpec(className);
    if (!spec) {
        throw new Error(`unknown node class '${className}'`);
    }

    const node = {
        _class: className,
        m_ID: makeGuid(),
        m_name: name ?? spec.title,
        m_floatingComment: '',
        m_position: [new KV3Float(position.x), new KV3Float(position.y)],
        m_inputPins: spec.inputs.map((pin) => createPin(pin.name, pin.type, {
            dynamic: pin.dynamic === true,
            allowMultiple: pin.allowMultiple === true,
        })),
        m_outputPins: spec.outputs.map((pin) => createPin(pin.name, pin.type, {
            dynamic: pin.dynamic === true,
            allowMultiple: pin.allowMultiple === true,
        })),
    };

    for (const [key, descriptor] of Object.entries(spec.properties ?? {})) {
        node[key] = defaultValue(descriptor);
    }

    if (spec.childGraph) {
        node.m_pChildGraph = {
            _class: 'CNmGraphDocFlowGraph',
            m_ID: makeGuid(),
            m_nodes: [],
            m_graphType: 'BlendTree',
            m_viewOffset: [new KV3Float(0), new KV3Float(0)],
            m_flViewZoom: new KV3Float(1),
            m_connections: [],
        };
    }

    return node;
}

/**
 * Whether a dynamic input pin can be appended to this node -- the Blend1D,
 * layer blend and boolean-fan-in families grow their input list as you wire
 * things into them.
 */
export function supportsDynamicInputs(className) {
    const spec = nodeSpec(className);
    return Boolean(spec?.dynamicInputs) || (spec?.inputs ?? []).some((pin) => pin.dynamic);
}

/** The pin template a dynamic input is cloned from. */
export function dynamicPinTemplate(className) {
    const spec = nodeSpec(className);
    if (!spec) {
        return null;
    }

    if (spec.dynamicInputs && typeof spec.dynamicInputs === 'object') {
        return { name: spec.dynamicInputs.name, type: spec.dynamicInputs.type };
    }

    const dynamic = (spec.inputs ?? []).find((pin) => pin.dynamic);
    if (dynamic) {
        return { name: dynamic.name, type: dynamic.type };
    }

    // Blend spaces grow pose inputs; that is the common case for the classes
    // whose pins the decompiler builds from the compiled source list.
    return { name: 'Input', type: 'Pose' };
}
