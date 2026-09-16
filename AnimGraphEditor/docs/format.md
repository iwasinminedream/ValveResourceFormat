# The authored AnimGraph 2 document

Notes on the `.vnmgraph` source format, as read out of ValveResourceFormat's
`NmGraphExtract`. This is what the editor manipulates; the compiled
`.vnmgraph_c` is a different, flattened thing.

## Document

```
CNmGraphDocument
  m_nVersion            int
  m_pRootGraph          CNmGraphDocFlowGraph
  m_variationHierarchy  { m_variations: [ { m_ID, m_parentID, m_skeleton } ] }
  m_debugParameterSets  []
  m_dictionaryIDSetIDs  []
```

## Canvases

Two classes, both holding a node list:

```
CNmGraphDocFlowGraph
  m_ID           guid
  m_nodes        [ node ]
  m_graphType    "BlendTree" | "ValueTree" | "VirtualParameterValueTree"
                 | "TransitionConduit" | "GlobalTransitionConduit" | "EntryOverrideTree"
  m_viewOffset   [ float, float ]
  m_flViewZoom   float
  m_connections  [ connection ]

CNmGraphDocStateMachineGraph
  m_ID, m_nodes, m_graphType = "StateMachine", m_viewOffset, m_flViewZoom
  m_entryStateID guid        -- the state the machine starts in
```

A state machine graph has **no** `m_connections`. Its structure lives in the
conduit nodes it contains, which name their endpoints by state id.

## Nodes

Every node shares a base:

```
_class             string
m_ID               guid
m_name             string
m_floatingComment  string
m_position         [ float, float ]
m_inputPins        [ pin ]
m_outputPins       [ pin ]
```

and may carry up to two nested canvases:

- `m_pChildGraph` — a state machine's states, a state's blend tree, a virtual
  parameter's value tree.
- `m_pSecondaryGraph` — a state's layer canvas, a transition conduit's condition
  graph, an entry-override conduit's condition graph.

Everything else is class-specific. `src/schema/nodes.json` lists it per class.

## Pins

```
m_ID                           guid
m_name                         string
m_type                         "Pose" | "Bool" | "Float" | "ID" | "Vector" | "Target" | "BoneMask"
m_bIsDynamicPin                bool   -- part of a list that grows, e.g. a blend space
m_bAllowMultipleOutConnections bool   -- an output that may feed several inputs
```

A `Pose` output is normally single-consumer; value outputs usually set
`m_bAllowMultipleOutConnections`.

## Connections

```
m_ID          guid
m_fromNodeID  guid   -- node that owns the output pin
m_outputPinID guid
m_toNodeID    guid   -- node that owns the input pin
m_inputPinID  guid
```

Pin ids are unique document-wide, so a connection is resolvable without knowing
which canvas it belongs to — but a connection only ever joins nodes inside the
same canvas.

## Rules the editor enforces

Taken from what the compiled format assumes, and from what the decompiler has to
be able to reconstruct:

- An output only wires to an input, and their `m_type` must match.
- An input takes at most one wire. Re-wiring replaces what was there.
- An output feeds one input unless `m_bAllowMultipleOutConnections` is set.
- No node feeds itself, and no chain of wires forms a cycle.
- Every id — graph, node and pin — is unique across the document.
- A state machine graph names an entry state that exists in it.

## Node families whose class name is composed

Several families exist once per value type, with the class name built at run
time from the type and a suffix:

| Suffix | Example | What it is |
| --- | --- | --- |
| `ControlParameter` | `CNmGraphDocFloatControlParameterNode` | A value the game sets |
| `VirtualParameter` | `CNmGraphDocFloatVirtualParameterNode` | A value computed by its own sub-graph |
| `Const` | `CNmGraphDocBoolConstNode` | A literal |
| `Result` | `CNmGraphDocFloatResultNode` | The output of a value tree |

The generator expands these across every value type rather than listing them.
