/**
 * Drives the editor in a real browser: loads the page, exercises the gestures
 * that matter (add, wire, drag, undo, descend, save) and fails on any console
 * error or unhandled rejection along the way.
 *
 * Run with `node tests/browser.smoke.mjs`. Needs Playwright and a Chromium.
 */

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}/`;

async function waitForServer(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const response = await fetch(BASE);
            if (response.ok) {
                return;
            }
        } catch {
            // Not listening yet.
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error('the static server never came up');
}

const server = spawn(process.execPath, [join(HERE, '..', 'tools', 'serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
});

/**
 * Playwright's own download would be pinned to its version; this environment
 * ships a Chromium already, so find that instead.
 */
function chromiumPath() {
    const candidates = [
        process.env.CHROMIUM_PATH,
        ...globSync('/opt/pw-browsers/chromium-*/chrome-linux/chrome'),
        '/opt/pw-browsers/chromium/chrome-linux/chrome',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error('no Chromium found; set CHROMIUM_PATH');
}

const failures = [];
let browser;

try {
    await waitForServer();

    browser = await chromium.launch({ executablePath: chromiumPath() });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    page.on('console', (message) => {
        if (message.type() === 'error') {
            failures.push(`console error: ${message.text()}`);
        }
    });
    page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
    page.on('requestfailed', (request) => failures.push(`request failed: ${request.url()}`));
    page.on('response', (response) => {
        if (response.status() >= 400) {
            failures.push(`HTTP ${response.status()} for ${response.url()}`);
        }
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });

    // The palette renders the generated catalog.
    const paletteGroups = await page.locator('#palette details').count();
    assert.ok(paletteGroups > 5, `expected palette groups, saw ${paletteGroups}`);

    // A new document starts with just the pose result node.
    assert.match(await page.locator('#counts').innerText(), /^1 nodes/);

    // Add a clip node from the palette.
    await page.fill('#palette-search', 'Clip');
    await page.locator('.palette-entry', { hasText: /^Clip$/ }).first().click();
    assert.match(await page.locator('#counts').innerText(), /^2 nodes/);

    // The inspector shows the node the palette just added.
    assert.match(await page.locator('#inspector h2').innerText(), /Clip/);

    // Rename it through the inspector and confirm the model took the edit.
    await page.fill('.inspector .field:has(span:text-is("Name")) input', 'idle_stand');
    assert.equal(
        await page.evaluate(() => globalThis.editor.graph.nodes.at(-1).name),
        'idle_stand',
    );

    // Wire the clip's Pose output into the result node's input, using the
    // anchors the renderer itself reports so the drag lands on the pins.
    const wire = await page.evaluate(() => {
        const app = globalThis.editor;
        const clip = app.graph.nodes.find((node) => node.name === 'idle_stand');
        const result = app.graph.nodes.find((node) => node.className === 'CNmGraphDocPoseResultNode');

        // Put them somewhere predictable first.
        clip.position = { x: 0, y: 0 };
        result.position = { x: 400, y: 0 };
        app.canvas.fit();

        const anchorOf = (node, pin) => {
            const list = pin.isInput ? node.inputs : node.outputs;
            const index = list.indexOf(pin);
            const x = pin.isInput ? node.position.x : node.position.x + 210;
            const y = node.position.y + 30 + index * 20 + 10;
            const rect = app.canvas.canvas.getBoundingClientRect();
            return {
                x: rect.left + x * app.canvas.zoom + app.canvas.offset.x,
                y: rect.top + y * app.canvas.zoom + app.canvas.offset.y,
            };
        };

        const output = clip.outputs.find((pin) => pin.type === 'Pose');
        const input = result.inputs[0];

        return { from: anchorOf(clip, output), to: anchorOf(result, input) };
    });

    await page.mouse.move(wire.from.x, wire.from.y);
    await page.mouse.down();
    await page.mouse.move(wire.to.x, wire.to.y, { steps: 12 });
    await page.mouse.up();

    assert.equal(
        await page.evaluate(() => globalThis.editor.graph.connections.length),
        1,
        'dragging from an output pin onto an input pin creates a wire',
    );
    assert.match(await page.locator('#counts').innerText(), /2 nodes, 1 wires/);

    // Clicking a wire selects it, at a zoom level where the screen-space hit
    // tolerance and the graph-space one differ.
    await page.evaluate(() => {
        globalThis.editor.canvas.zoom = 1.8;
        globalThis.editor.canvas.draw();
    });

    const wireMidpoint = await page.evaluate(() => {
        const app = globalThis.editor;
        const [connection] = app.graph.connections;
        const from = app.graph.node(connection.m_fromNodeID);
        const to = app.graph.node(connection.m_toNodeID);
        const rect = app.canvas.canvas.getBoundingClientRect();

        const toScreen = (x, y) => ({
            x: rect.left + x * app.canvas.zoom + app.canvas.offset.x,
            y: rect.top + y * app.canvas.zoom + app.canvas.offset.y,
        });

        const start = toScreen(from.position.x + 210, from.position.y + 40);
        const end = toScreen(to.position.x, to.position.y + 40);
        return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    });

    await page.mouse.click(wireMidpoint.x, wireMidpoint.y);
    assert.notEqual(
        await page.evaluate(() => globalThis.editor.canvas.selectedConnectionId),
        null,
        'clicking a wire selects it',
    );

    // An undo must not throw away the pan and zoom the user set up.
    const viewBefore = await page.evaluate(() => ({
        zoom: globalThis.editor.canvas.zoom,
        offset: { ...globalThis.editor.canvas.offset },
    }));

    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');

    assert.deepEqual(
        await page.evaluate(() => ({
            zoom: globalThis.editor.canvas.zoom,
            offset: { ...globalThis.editor.canvas.offset },
        })),
        viewBefore,
        'undo and redo leave the view where it was',
    );

    // Undo removes the wire; redo restores it.
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => globalThis.editor.graph.connections.length), 0);
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.evaluate(() => globalThis.editor.graph.connections.length), 1);

    // Dragging a node moves it, and the whole drag undoes in one step.
    const before = await page.evaluate(() => {
        const node = globalThis.editor.graph.nodes.find((entry) => entry.name === 'idle_stand');
        return node.position;
    });

    const nodeBody = await page.evaluate(() => {
        const app = globalThis.editor;
        const node = app.graph.nodes.find((entry) => entry.name === 'idle_stand');
        const rect = app.canvas.canvas.getBoundingClientRect();
        return {
            x: rect.left + (node.position.x + 100) * app.canvas.zoom + app.canvas.offset.x,
            y: rect.top + (node.position.y + 8) * app.canvas.zoom + app.canvas.offset.y,
        };
    });

    await page.mouse.move(nodeBody.x, nodeBody.y);
    await page.mouse.down();
    await page.mouse.move(nodeBody.x + 90, nodeBody.y + 60, { steps: 10 });
    await page.mouse.up();

    const after = await page.evaluate(() => {
        const node = globalThis.editor.graph.nodes.find((entry) => entry.name === 'idle_stand');
        return node.position;
    });
    assert.notDeepEqual(after, before, 'the node moved');

    await page.keyboard.press('Control+z');
    assert.deepEqual(
        await page.evaluate(() => {
            const node = globalThis.editor.graph.nodes.find((entry) => entry.name === 'idle_stand');
            return node.position;
        }),
        before,
        'one undo put the node back where the drag started',
    );

    // Descending into a state machine's canvas and back out again.
    await page.fill('#palette-search', 'State Machine');
    await page.locator('.palette-entry', { hasText: /^State Machine$/ }).first().click();
    await page.evaluate(() => {
        const app = globalThis.editor;
        app.openNode(app.graph.nodes.at(-1));
    });

    assert.equal(await page.locator('#breadcrumb button').count(), 2);
    await page.locator('#breadcrumb button').first().click();
    assert.equal(
        await page.evaluate(() => globalThis.editor.breadcrumb.length),
        0,
        'the breadcrumb navigates back to the root canvas',
    );

    // Auto-layout runs and stays undoable.
    await page.click('#layout');
    assert.equal(await page.evaluate(() => globalThis.editor.history.canUndo), true);

    // The document serializes to KV3 that parses back to the same graph.
    const roundTripped = await page.evaluate(async () => {
        const app = globalThis.editor;
        const text = app.serialize();
        const { parseKV3 } = await import('./src/kv3/parse.js');
        const { GraphDocument } = await import('./src/model/document.js');
        const reloaded = new GraphDocument(parseKV3(text).root);

        return {
            startsWithHeader: text.startsWith('<!-- kv3 '),
            nodes: reloaded.rootGraph.nodes.length,
            wires: reloaded.rootGraph.connections.length,
            hasClip: reloaded.rootGraph.nodes.some((node) => node.name === 'idle_stand'),
        };
    });

    assert.equal(roundTripped.startsWithHeader, true);
    assert.equal(roundTripped.nodes, 3);
    assert.equal(roundTripped.wires, 1);
    assert.equal(roundTripped.hasClip, true);

    // The bundled sample opens and its nested canvases are navigable.
    await page.evaluate(() => { globalThis.editor.dirty = false; });
    await page.click('#sample');
    await page.waitForFunction(() => globalThis.editor.fileName === 'sample.vnmgraph');

    assert.equal(
        await page.evaluate(() => globalThis.editor.document.allGraphs().length),
        9,
        'the sample brings nine canvases with it',
    );
    assert.match(await page.locator('#counts').innerText(), /^5 nodes, 1 wires/);

    await page.evaluate(() => {
        const app = globalThis.editor;
        app.openNode(app.graph.nodes.find((node) => node.name === 'locomotion'));
    });
    assert.equal(
        await page.evaluate(() => globalThis.editor.graph.isStateMachine),
        true,
        'double-clicking the state machine opens its canvas',
    );
    await page.locator('#breadcrumb button').first().click();

    // A clean sample reports no errors in the problems panel.
    assert.doesNotMatch(await page.locator('#problem-count').innerText(), /error/);

    // Deleting the selection clears it from the document.
    await page.evaluate(() => {
        const app = globalThis.editor;
        app.canvas.selectNode(app.graph.nodes.find((node) => node.name === 'speed'));
    });
    await page.keyboard.press('Delete');
    assert.equal(
        await page.evaluate(() => globalThis.editor.graph.nodes.some((node) => node.name === 'speed')),
        false,
    );

    if (failures.length > 0) {
        throw new Error(`browser reported problems:\n  ${failures.join('\n  ')}`);
    }

    console.log('browser smoke test passed');
} finally {
    await browser?.close();
    server.kill();
}
