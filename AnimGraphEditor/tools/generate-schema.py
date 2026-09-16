#!/usr/bin/env python3
"""
Derives the AnimGraph 2 (NmGraph) authored-document node catalog from the
ValveResourceFormat decompiler sources and writes it to src/schema/nodes.json.

The decompiler is the only complete description of the `CNmGraphDocument` shape
that exists outside Valve's own tools: every node class it emits, the pins that
class carries, and the properties it writes are spelled out in
`NmGraphExtract*.cs`. Reading them out mechanically keeps the editor's catalog
honest -- re-run this after syncing the fork and the diff shows what Valve (or
the decompiler) changed.

Usage: python3 tools/generate-schema.py [path-to-ValveResourceFormat-repo]
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
DEFAULT_REPO = os.path.dirname(PROJECT)

EXTRACT_DIR = os.path.join("ValveResourceFormat", "IO", "Extract")
SOURCES = [
    os.path.join(EXTRACT_DIR, "NmGraphExtract.cs"),
    os.path.join(EXTRACT_DIR, "NmGraphExtract.NodeSpecs.cs"),
    os.path.join(EXTRACT_DIR, "NmGraphExtract.Types.cs"),
    os.path.join(EXTRACT_DIR, "NmGraphExtract.VirtualParameterTypes.cs"),
]

# Pin value types the graph carries. Taken from the pin `m_type` strings the
# decompiler emits; kept as an explicit list so the editor can validate a
# connection without inspecting every node spec.
VALUE_TYPES = ["Pose", "Bool", "ID", "Float", "Vector", "Target", "BoneMask"]


def read(repo: str, relative: str) -> str:
    with open(os.path.join(repo, relative), "r", encoding="utf-8") as handle:
        return handle.read()


def strip_comments(text: str) -> str:
    """Drops // and /* */ comments so their contents never parse as code."""
    out = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == '"':
                    break
                j += 1
            out.append(text[i:j + 1])
            i = j + 1
            continue
        if text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if text.startswith("/*", i):
            j = text.find("*/", i)
            i = n if j < 0 else j + 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def split_arguments(text: str) -> list[str]:
    """Splits a C# argument list on top-level commas."""
    args = []
    depth = 0
    current = []
    in_string = False
    i = 0
    while i < len(text):
        ch = text[i]
        if in_string:
            current.append(ch)
            if ch == "\\":
                if i + 1 < len(text):
                    current.append(text[i + 1])
                    i += 2
                    continue
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            current.append(ch)
        elif ch in "([{":
            depth += 1
            current.append(ch)
        elif ch in ")]}":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            args.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
        i += 1
    tail = "".join(current).strip()
    if tail:
        args.append(tail)
    return args


def match_balanced(text: str, start: int, open_ch: str, close_ch: str) -> int:
    """Index just past the bracket pair that opens at `start`."""
    depth = 0
    in_string = False
    i = start
    while i < len(text):
        ch = text[i]
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError("unbalanced brackets")


PIN_RE = re.compile(
    r'new(?:\s+PinDef)?\s*\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"([A-Za-z]+)"([^)]*)\)'
)


def parse_pins(expression: str) -> list[dict]:
    pins = []
    for name, value_type, rest in PIN_RE.findall(expression):
        pin = {"name": name.replace('\\"', '"'), "type": value_type}
        if "IsDynamicPin: true" in rest or "isDynamicPin: true" in rest:
            pin["dynamic"] = True
        if "AllowMultipleOutConnections: true" in rest or "allowMultipleOutConnections: true" in rest:
            pin["allowMultiple"] = True
        pins.append(pin)
    return pins


BOOL_DEFAULT_RE = re.compile(r",\s*(true|false)\s*\)\s*$")
FLOAT_DEFAULT_RE = re.compile(r",\s*(-?[0-9.]+)f?\s*\)\s*$")
STRING_DEFAULT_RE = re.compile(r',\s*"((?:[^"\\]|\\.)*)"\s*\)\s*$')
INT_DEFAULT_RE = re.compile(r",\s*(-?[0-9]+)L?\s*\)\s*$")


def classify_property(expression: str) -> dict:
    """Infers a property's editable type and default from how it is written."""
    expression = expression.strip()

    if expression in ("string.Empty", '""'):
        return {"type": "string", "default": ""}
    literal_string = re.fullmatch(r'"((?:[^"\\]|\\.)*)"', expression)
    if literal_string:
        return {"type": "string", "default": literal_string.group(1)}
    if expression in ("true", "false"):
        return {"type": "bool", "default": expression == "true"}
    literal_float = re.fullmatch(r"-?[0-9]*\.[0-9]+f?", expression)
    if literal_float:
        return {"type": "float", "default": float(expression.rstrip("f"))}
    literal_int = re.fullmatch(r"-?[0-9]+L?", expression)
    if literal_int:
        return {"type": "int", "default": int(expression.rstrip("L"))}

    if "GetRequiredBooleanProperty" in expression:
        return {"type": "bool", "default": False}
    if "GetBooleanProperty" in expression:
        match = BOOL_DEFAULT_RE.search(expression)
        return {"type": "bool", "default": match.group(1) == "true" if match else False}
    if "GetRequiredFloatProperty" in expression or "MathF." in expression:
        return {"type": "float", "default": 0.0}
    if "GetFloatProperty" in expression:
        match = FLOAT_DEFAULT_RE.search(expression)
        return {"type": "float", "default": float(match.group(1)) if match else 0.0}
    if "GetInt64Property" in expression or "GetIntegerProperty" in expression or "GetInt32Property" in expression:
        match = INT_DEFAULT_RE.search(expression)
        return {"type": "int", "default": int(match.group(1)) if match else 0}
    if "GetOptionalString" in expression or "GetStringProperty" in expression:
        match = STRING_DEFAULT_RE.search(expression)
        return {"type": "string", "default": match.group(1) if match else ""}
    if "Guid.Empty.ToString()" in expression:
        return {"type": "guid", "default": "00000000-0000-0000-0000-000000000000"}
    if ("KVObject.Array()" in expression or "CloneArray" in expression
            or "CloneStringArray" in expression or "CreateVariationOverrides" in expression
            or "ConvertStateEvents" in expression or "timedStateEvents" in expression):
        return {"type": "array", "default": []}
    if "GetResourcePath" in expression or "ResourceName" in expression:
        return {"type": "resource", "default": ""}
    return {"type": "object", "default": None}


METHOD_RE = re.compile(
    r"(?:private|internal|public)\s+(?:static\s+)?KVObject\??\s+(\w+)\s*\(",
)


def iter_methods(text: str):
    """Yields (method name, body) for every KVObject-returning method."""
    for match in METHOD_RE.finditer(text):
        signature_end = match.end() - 1
        try:
            args_end = match_balanced(text, signature_end, "(", ")")
        except ValueError:
            continue
        body_start = text.find("{", args_end)
        if body_start < 0:
            continue
        # A `=>` bodied method has no block.
        if "=>" in text[args_end:body_start]:
            continue
        try:
            body_end = match_balanced(text, body_start, "{", "}")
        except ValueError:
            continue
        yield match.group(1), text[body_start:body_end]


ADD_RE = re.compile(r'\bnode\.Add\(\s*"(m_\w+)"\s*,')
ADD_VALUE_RE = re.compile(r'\bAddValue\(\s*node\s*,\s*"(m_\w+)"\s*,')
INDEXER_RE = re.compile(r'\bnode\[\s*"(m_\w+)"\s*\]\s*=')
BASE_NODE_RE = re.compile(r'CreateBaseNode\(\s*(?:"([^"]+)"|(\w+))\s*,')
MAKE_PINS_RE = re.compile(r'\bnode\.Add\(\s*"(m_inputPins|m_outputPins)"\s*,')


def argument_after(body: str, match: re.Match) -> str:
    """The single argument that follows a matched `Add("key",` prefix."""
    open_paren = body.rfind("(", 0, match.end())
    end = match_balanced(body, open_paren, "(", ")")
    return split_arguments(body[open_paren + 1:end - 1])[-1]


def parse_node_builders(text: str) -> dict:
    """Node classes built by an explicit `Create...Node` method."""
    nodes = {}
    for name, body in iter_methods(text):
        base = BASE_NODE_RE.search(body)
        if not base:
            continue
        class_name = base.group(1)
        if class_name is None:
            # Built from a computed class name (typed Const/ControlParameter
            # families); those are expanded separately.
            continue

        entry = nodes.setdefault(
            class_name,
            {"class": class_name, "builder": name, "inputs": [], "outputs": [], "properties": OrderedDict()},
        )

        for pins_match in MAKE_PINS_RE.finditer(body):
            expression = argument_after(body, pins_match)
            pins = parse_pins(expression)
            key = "inputs" if pins_match.group(1) == "m_inputPins" else "outputs"
            if pins and not entry[key]:
                entry[key] = pins
            if "MakePinsWithOverrides" in expression or "inputPins" == expression.strip():
                entry["dynamicInputs"] = True

        for prop_match in list(ADD_RE.finditer(body)) + list(ADD_VALUE_RE.finditer(body)):
            key = prop_match.group(1)
            if key in ("m_inputPins", "m_outputPins"):
                continue
            expression = argument_after(body, prop_match)
            entry["properties"].setdefault(key, classify_property(expression))

        for indexer_match in INDEXER_RE.finditer(body):
            key = indexer_match.group(1)
            if key == "m_pChildGraph":
                entry["childGraph"] = True
            elif key == "m_pSecondaryGraph":
                entry["secondaryGraph"] = True
            else:
                entry["properties"].setdefault(key, {"type": "object", "default": None})

        if "m_pChildGraph" in body and 'node.Add("m_pChildGraph"' in body:
            entry["childGraph"] = True

    return nodes


SPEC_ENTRY_RE = re.compile(r'\["(\w+)"\]\s*=\s*(SimpleValueSpec|SimplePoseSpec|CachedValueSpec)\s*\(')


def parse_node_specs(text: str) -> dict:
    """Node classes declared in the table-driven `FlowNodeSpecs` catalog."""
    nodes = {}
    for match in SPEC_ENTRY_RE.finditer(text):
        stem, factory = match.group(1), match.group(2)
        open_paren = match.end() - 1
        end = match_balanced(text, open_paren, "(", ")")
        args = split_arguments(text[open_paren + 1:end - 1])
        if not args:
            continue
        class_name = args[0].strip().strip('"')

        if factory == "SimplePoseSpec":
            entry = {
                "class": class_name,
                "stems": [stem],
                "inputs": [],
                "outputs": [{"name": "Pose", "type": "Pose"}],
                "properties": OrderedDict(),
            }
        elif factory == "CachedValueSpec":
            value_type = args[1].strip().strip('"')
            entry = {
                "class": class_name,
                "stems": [stem],
                "inputs": [{"name": "Value", "type": value_type}],
                "outputs": [{"name": "Result", "type": value_type, "allowMultiple": True}],
                "properties": OrderedDict(
                    [("m_mode", {"type": "string", "default": "OnEntry", "enum": ["OnEntry", "OnExit"]})]
                ),
            }
        else:
            pins_argument = args[1] if len(args) > 1 else "[]"
            output_type = args[2].strip().strip('"') if len(args) > 2 else "Pose"
            allow_multiple = "allowMultipleOutConnections: false" not in text[open_paren:end]
            output_name = "Pose" if output_type == "Pose" else "Result"
            output = {"name": output_name, "type": output_type}
            if allow_multiple:
                output["allowMultiple"] = True
            entry = {
                "class": class_name,
                "stems": [stem],
                "inputs": parse_pins(pins_argument),
                "outputs": [output],
                "properties": OrderedDict(),
            }
            if "=>" in pins_argument and "CreateRepeatedPins" in pins_argument:
                repeated = re.search(r'CreateRepeatedPins\("([^"]+)",\s*"(\w+)"', pins_argument)
                if repeated:
                    entry["dynamicInputs"] = {"name": repeated.group(1), "type": repeated.group(2), "minimum": 2}
                    entry["inputs"] = [
                        {"name": repeated.group(1), "type": repeated.group(2), "dynamic": True} for _ in range(2)
                    ]

            for key, value in re.findall(r'\("(m_\w+)",\s*"([^"]*)"\)', text[open_paren:end]):
                entry["properties"].setdefault(key, {"type": "string", "default": value})

        existing = nodes.get(class_name)
        if existing:
            existing["stems"].append(stem)
            continue
        nodes[class_name] = entry
    return nodes


TYPED_FAMILY_RE = re.compile(r'GetTypedDocNodeClassName\(\s*\w+\s*,\s*"(\w+)"\s*\)')


def parse_typed_families(text: str) -> dict:
    """
    Expands the families whose class name is composed at run time, e.g.
    `CNmGraphDocBoolControlParameterNode`. `GetTypedDocNodeClassName` builds
    them from a value type plus a suffix, so the catalog lists one class per
    (value type, suffix) pair.
    """
    suffixes = sorted(set(TYPED_FAMILY_RE.findall(text)))
    families = {}
    for suffix in suffixes:
        for value_type in VALUE_TYPES:
            if suffix in ("ControlParameter", "VirtualParameter") and value_type == "Pose":
                continue
            class_name = f"CNmGraphDoc{value_type}{suffix}Node"
            if suffix in ("ControlParameter", "VirtualParameter"):
                entry = {
                    "class": class_name,
                    "family": suffix,
                    "valueType": value_type,
                    "inputs": [],
                    "outputs": [{"name": "Value", "type": value_type, "allowMultiple": True}],
                    "properties": OrderedDict([("m_groupName", {"type": "string", "default": ""})]),
                }
                if suffix == "ControlParameter":
                    entry["properties"]["m_dictionaryParameterBinding"] = {
                        "type": "guid",
                        "default": "00000000-0000-0000-0000-000000000000",
                    }
                else:
                    entry["childGraph"] = True
            elif suffix == "Result":
                entry = {
                    "class": class_name,
                    "family": suffix,
                    "valueType": value_type,
                    "inputs": [{"name": "Out", "type": value_type}],
                    "outputs": [],
                    "properties": OrderedDict(),
                }
            elif suffix == "Const":
                entry = {
                    "class": class_name,
                    "family": suffix,
                    "valueType": value_type,
                    "inputs": [],
                    "outputs": [{"name": "Result", "type": value_type, "allowMultiple": True}],
                    "properties": OrderedDict([("m_value", {"type": value_type.lower(), "default": None})]),
                }
            else:
                entry = {
                    "class": class_name,
                    "family": suffix,
                    "valueType": value_type,
                    "inputs": [],
                    "outputs": [{"name": "Result", "type": value_type, "allowMultiple": True}],
                    "properties": OrderedDict(),
                }
            families[class_name] = entry
    return families


STEM_RE = re.compile(r'"(\w+)"\s*=>\s*(?:Build|Create)(\w*?)Node?\(\s*(?:"([^"]+)")?')


def parse_stem_map(text: str) -> dict:
    """Maps the compiled node stem onto the doc class the switch builds for it."""
    stems = {}
    for stem, _, explicit_class in STEM_RE.findall(text):
        if explicit_class:
            stems.setdefault(explicit_class, []).append(stem)
    return stems


def humanise(class_name: str) -> str:
    stem = re.sub(r"^CNmGraphDoc|^CnmGraphDoc", "", class_name)
    stem = re.sub(r"Node$", "", stem)
    stem = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", stem)
    stem = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", stem)
    stem = re.sub(r"(?<=[a-zA-Z])(?=[0-9])", " ", stem)
    return stem.strip() or class_name


CATEGORY_RULES = [
    ("Parameter", ("ControlParameter", "VirtualParameter", "ParameterReference")),
    ("Result", ("Result",)),
    ("State Machine", ("StateMachine", "State", "Transition", "Conduit")),
    ("Animation", ("Clip", "AnimationPose", "ZeroPose", "ReferencePose", "Blend", "Selector", "LayerBlend", "VelocityBlend")),
    ("IK & Warp", ("IK", "Ik", "Warp", "FollowBone", "ChainLookat", "AimCS", "RootMotion", "SnapWeapon")),
    ("Bone Mask", ("BoneMask",)),
    ("Float", ("Float",)),
    ("Vector", ("Vector",)),
    ("Target", ("Target",)),
    ("ID", ("ID", "Id")),
    ("Event", ("Event", "Footstep", "Foot")),
    ("Logic", ("And", "Or", "Not", "Const", "Cached", "Switch", "Comparison", "Condition")),
    ("Scale", ("Scale", "Duration", "Speed")),
    ("External", ("External", "ReferencedGraph")),
]


def categorise(class_name: str) -> str:
    for category, needles in CATEGORY_RULES:
        if any(needle in class_name for needle in needles):
            return category
    return "Other"


def git_commit(repo: str) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", repo, "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def main() -> int:
    repo = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_REPO
    missing = [source for source in SOURCES if not os.path.exists(os.path.join(repo, source))]
    if missing:
        print(f"error: not a ValveResourceFormat checkout: {repo}", file=sys.stderr)
        for source in missing:
            print(f"  missing {source}", file=sys.stderr)
        return 1

    texts = {source: strip_comments(read(repo, source)) for source in SOURCES}
    combined = "\n".join(texts.values())

    nodes: dict = {}
    nodes.update(parse_typed_families(combined))
    nodes.update(parse_node_specs(texts[SOURCES[1]]))

    for class_name, entry in parse_node_builders(texts[SOURCES[0]]).items():
        existing = nodes.get(class_name)
        if existing:
            existing.setdefault("builder", entry.get("builder"))
            for key, value in entry["properties"].items():
                existing.setdefault("properties", OrderedDict()).setdefault(key, value)
            if entry["inputs"] and not existing["inputs"]:
                existing["inputs"] = entry["inputs"]
            if entry["outputs"] and not existing["outputs"]:
                existing["outputs"] = entry["outputs"]
            if entry.get("childGraph"):
                existing["childGraph"] = True
            if entry.get("secondaryGraph"):
                existing["secondaryGraph"] = True
            if entry.get("dynamicInputs"):
                existing.setdefault("dynamicInputs", True)
            continue
        nodes[class_name] = entry

    stem_map = parse_stem_map(texts[SOURCES[0]])
    for class_name, stems in stem_map.items():
        if class_name in nodes:
            nodes[class_name].setdefault("stems", []).extend(
                stem for stem in stems if stem not in nodes[class_name].get("stems", [])
            )

    catalog = OrderedDict()
    for class_name in sorted(nodes):
        entry = nodes[class_name]
        catalog[class_name] = OrderedDict(
            [
                ("class", class_name),
                ("title", humanise(class_name)),
                ("category", categorise(class_name)),
                ("inputs", entry.get("inputs", [])),
                ("outputs", entry.get("outputs", [])),
                ("properties", entry.get("properties", OrderedDict())),
            ]
        )
        for optional in ("stems", "family", "valueType", "childGraph", "secondaryGraph", "dynamicInputs"):
            if entry.get(optional):
                catalog[class_name][optional] = entry[optional]

    document = OrderedDict(
        [
            (
                "$comment",
                "Generated by AnimGraphEditor/tools/generate-schema.py from the "
                "ValveResourceFormat NmGraph decompiler. Do not edit by hand.",
            ),
            (
                "source",
                OrderedDict(
                    [
                        ("repository", "SteamDatabase/ValveResourceFormat"),
                        ("commit", git_commit(repo)),
                        ("files", SOURCES),
                    ]
                ),
            ),
            ("valueTypes", VALUE_TYPES),
            ("nodes", catalog),
        ]
    )

    schema_dir = os.path.join(PROJECT, "src", "schema")
    body = json.dumps(document, indent=2, ensure_ascii=False)

    json_target = os.path.join(schema_dir, "nodes.json")
    with open(json_target, "w", encoding="utf-8") as handle:
        handle.write(body + "\n")

    # The editor runs from a plain static server with no bundler, so the catalog
    # also ships as an ES module that both the browser and `node --test` import
    # directly.
    module_target = os.path.join(schema_dir, "nodes.generated.js")
    with open(module_target, "w", encoding="utf-8") as handle:
        handle.write("// Generated by tools/generate-schema.py. Do not edit by hand.\n")
        handle.write("export default " + body + ";\n")

    print(f"wrote {json_target} and {module_target}: {len(catalog)} node classes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
