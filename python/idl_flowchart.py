#!/usr/bin/env python3
import json
import sys

from idl_parser import detect_control_flow, find_routines, preprocess_source


def main() -> None:
    request = json.loads(sys.stdin.read())
    file_path = request["file"]
    target_line = request["line"]

    with open(file_path, "r", encoding="utf-8", errors="replace") as handle:
        source = handle.read()

    lines = preprocess_source(source)
    routines = find_routines(lines)
    target_routine = None
    for routine in routines:
        if routine.start_line <= target_line <= routine.end_line:
            target_routine = routine
            break
    if target_routine is None:
        if not routines:
            print(json.dumps({"error": "No routine found"}))
            return
        target_routine = routines[-1]

    cf_nodes = detect_control_flow(target_routine.body_lines)
    kind_label = "FUNCTION" if target_routine.kind == "function" else "PRO"
    entry_label = f"{kind_label} {target_routine.name}"
    if target_routine.params:
        entry_label += f"({', '.join(target_routine.params)})"

    graph_nodes = [{
        "id": "entry",
        "kind": "entry",
        "label": entry_label,
        "source": {"file": file_path, "line": target_routine.start_line, "endLine": target_routine.start_line},
        "metadata": {"displayLines": [entry_label]},
    }]
    graph_edges = []
    prev_id = "entry"
    loop_stack = []

    for cf in cf_nodes:
        graph_nodes.append({
            "id": cf["id"],
            "kind": cf["kind"],
            "label": cf["label"],
            "source": {"file": file_path, "line": cf["line"], "endLine": cf["line"]},
        })
        structure = cf.get("structure", "")

        if structure == "if":
            graph_edges.append({"id": f"e-{prev_id}-{cf['id']}", "from": prev_id, "to": cf["id"], "kind": "control_flow"})
            prev_id = cf["id"]
            continue
        if structure == "else":
            graph_edges.append({"id": f"e-{prev_id}-{cf['id']}", "from": prev_id, "to": cf["id"], "kind": "control_flow", "label": "no"})
            prev_id = cf["id"]
            continue
        if structure == "loop":
            graph_edges.append({"id": f"e-{prev_id}-{cf['id']}", "from": prev_id, "to": cf["id"], "kind": "control_flow"})
            loop_stack.append(cf["id"])
            prev_id = cf["id"]
            continue
        if structure == "repeat":
            graph_edges.append({"id": f"e-{prev_id}-{cf['id']}", "from": prev_id, "to": cf["id"], "kind": "control_flow"})
            loop_stack.append(cf["id"])
            prev_id = cf["id"]
            continue
        if structure == "end_loop":
            if loop_stack:
                graph_edges.append({"id": f"e-{prev_id}-{loop_stack[-1]}-repeat", "from": prev_id, "to": loop_stack[-1], "kind": "control_flow", "label": "repeat"})
                loop_stack.pop()
            graph_edges.append({"id": f"e-{prev_id}-{cf['id']}", "from": prev_id, "to": cf["id"], "kind": "control_flow", "label": "done"})
            prev_id = cf["id"]
            continue
        if structure == "end_repeat":
            if loop_stack:
                graph_edges.append({"id": f"e-{prev_id}-{loop_stack[-1]}-repeat", "from": prev_id, "to": loop_stack[-1], "kind": "control_flow", "label": "repeat"})
                loop_stack.pop()
            graph_edges.append({"id": f"e-{prev_id}-{cf['id']}", "from": prev_id, "to": cf["id"], "kind": "control_flow", "label": "until"})
            prev_id = cf["id"]
            continue

        graph_edges.append({"id": f"e-{prev_id}-{cf['id']}", "from": prev_id, "to": cf["id"], "kind": "control_flow"})
        prev_id = cf["id"]

    graph = {
        "graphType": "flowchart",
        "title": f"{target_routine.name}()",
        "subtitle": file_path,
        "nodes": graph_nodes,
        "edges": graph_edges,
        "rootNodeIds": ["entry"],
        "metadata": {
            "function": target_routine.name,
            "params": target_routine.params,
            "groups": [],
            "language": "idl",
        },
    }
    print(json.dumps(graph))


if __name__ == "__main__":
    main()
