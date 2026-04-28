#!/usr/bin/env python3
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

from idl_parser import detect_control_flow, find_routines, preprocess_source


def main() -> None:
    request = json.loads(sys.stdin.read())
    file_path = request["file"]
    target_line = request.get("line", 1)
    scope = (request.get("scope") or "function").lower()

    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as handle:
            source = handle.read()
    except Exception as exc:  # pragma: no cover - surface filesystem issues
        print(json.dumps({"error": str(exc), "graphType": "flowchart", "nodes": [], "edges": []}))
        return

    lines = preprocess_source(source)
    routines = find_routines(lines)

    if scope == "file":
        graph = build_file_flowchart(file_path, lines, routines)
        print(json.dumps(graph))
        return

    target_routine = None
    for routine in routines:
        if routine.start_line <= target_line <= routine.end_line:
            target_routine = routine
            break
    if target_routine is None:
        if not routines:
            print(json.dumps({
                "error": "No routine found",
                "graphType": "flowchart",
                "title": os.path.basename(file_path),
                "subtitle": file_path,
                "nodes": [],
                "edges": [],
                "metadata": {"language": "idl"},
            }))
            return
        target_routine = routines[-1]

    print(json.dumps(build_routine_flowchart(file_path, target_routine)))


def build_routine_flowchart(file_path: str, target_routine: Any) -> Dict[str, Any]:
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
    groups: List[Dict[str, Any]] = []
    prev_id = "entry"
    loop_stack = []
    inline_if_context = None
    case_stack = []
    loop_group_stack = []
    branch_group_stack = []
    open_groups: List[Dict[str, Any]] = []
    group_counter = 0
    indent_base, indent_step = compute_indent_scale(cf_nodes)

    def begin_group(kind: str, label: str, line: int) -> Dict[str, Any]:
        nonlocal group_counter
        group_counter += 1
        group = {
            "id": f"group_{group_counter}",
            "kind": kind,
            "label": label,
            "line": line,
            "parentGroupId": open_groups[-1]["id"] if open_groups else None,
            "nodeIds": [],
        }
        groups.append(group)
        open_groups.append(group)
        return group

    def end_group(group: Optional[Dict[str, Any]]) -> None:
        if not group:
            return
        if open_groups and open_groups[-1]["id"] == group["id"]:
            open_groups.pop()

    def attach_to_open_groups(node_id: str) -> None:
        for group in open_groups:
            group["nodeIds"].append(node_id)

    def add_edge(source: str, target: str, label: Optional[str] = None) -> None:
        edge = {"id": f"e-{source}-{target}-{len(graph_edges)}", "from": source, "to": target, "kind": "control_flow"}
        if label:
            edge["label"] = label
        graph_edges.append(edge)

    body_group = begin_group("function_body", f"{target_routine.name} body", target_routine.start_line)

    cf_nodes = collapse_statement_runs(cf_nodes)

    for cf in cf_nodes:
        node_metadata = build_node_metadata(cf, indent_base, indent_step)
        graph_nodes.append({
            "id": cf["id"],
            "kind": cf["kind"],
            "label": cf["label"],
            "source": {"file": file_path, "line": cf["line"], "endLine": cf["line"]},
            "metadata": node_metadata,
        })
        attach_to_open_groups(cf["id"])
        structure = cf.get("structure", "")

        if inline_if_context and structure not in {"if_then", "if_else"}:
            tails = inline_if_context["tails"]
            if not inline_if_context["has_else"]:
                add_edge(inline_if_context["decision_id"], cf["id"], "no")
            if tails:
                for tail in tails:
                    add_edge(tail, cf["id"])
            end_group(inline_if_context.get("group"))
            inline_if_context = None

        if structure == "inline_if":
            add_edge(prev_id, cf["id"])
            branch_group = begin_group("branch", cf["label"], cf["line"])
            branch_group["nodeIds"].append(cf["id"])
            inline_if_context = {"decision_id": cf["id"], "tails": [], "has_else": False, "group": branch_group}
            prev_id = cf["id"]
            continue

        if structure == "if_then":
            source = inline_if_context["decision_id"] if inline_if_context else prev_id
            add_edge(source, cf["id"], "yes")
            if inline_if_context is not None:
                inline_if_context["tails"].append(cf["id"])
            prev_id = cf["id"]
            continue

        if structure == "if_else":
            source = inline_if_context["decision_id"] if inline_if_context else prev_id
            add_edge(source, cf["id"], "no")
            if inline_if_context is not None:
                inline_if_context["has_else"] = True
                inline_if_context["tails"].append(cf["id"])
            prev_id = cf["id"]
            continue

        if structure == "if":
            add_edge(prev_id, cf["id"])
            branch_group = begin_group("branch", cf["label"], cf["line"])
            branch_group["nodeIds"].append(cf["id"])
            branch_group_stack.append(branch_group)
            prev_id = cf["id"]
            continue
        if structure == "else":
            add_edge(prev_id, cf["id"], "no")
            prev_id = cf["id"]
            continue
        if structure == "loop":
            add_edge(prev_id, cf["id"])
            loop_stack.append(cf["id"])
            loop_group = begin_group("loop", cf["label"], cf["line"])
            loop_group["nodeIds"].append(cf["id"])
            loop_group_stack.append(loop_group)
            prev_id = cf["id"]
            continue
        if structure == "repeat":
            add_edge(prev_id, cf["id"])
            loop_stack.append(cf["id"])
            loop_group = begin_group("loop", cf["label"], cf["line"])
            loop_group["nodeIds"].append(cf["id"])
            loop_group_stack.append(loop_group)
            prev_id = cf["id"]
            continue
        if structure == "case":
            add_edge(prev_id, cf["id"])
            case_stack.append({"case_id": cf["id"], "branch_tails": [], "pending_tail": None})
            branch_group = begin_group("branch", cf["label"], cf["line"])
            branch_group["nodeIds"].append(cf["id"])
            branch_group_stack.append(branch_group)
            prev_id = cf["id"]
            continue
        if structure in {"case_branch", "case_else"}:
            case_context = case_stack[-1] if case_stack else None
            if case_context and case_context["pending_tail"]:
                case_context["branch_tails"].append(case_context["pending_tail"])
            source = case_context["case_id"] if case_context else prev_id
            add_edge(source, cf["id"])
            if case_context:
                case_context["pending_tail"] = cf["id"]
            prev_id = cf["id"]
            continue
        if structure == "case_action":
            add_edge(prev_id, cf["id"])
            if case_stack:
                case_stack[-1]["pending_tail"] = cf["id"]
            prev_id = cf["id"]
            continue
        if structure == "end_loop":
            if loop_stack:
                add_edge(prev_id, loop_stack[-1], "repeat")
                loop_stack.pop()
            add_edge(prev_id, cf["id"], "done")
            end_group(loop_group_stack.pop() if loop_group_stack else None)
            prev_id = cf["id"]
            continue
        if structure == "end_repeat":
            if loop_stack:
                add_edge(prev_id, loop_stack[-1], "repeat")
                loop_stack.pop()
            add_edge(prev_id, cf["id"], "until")
            end_group(loop_group_stack.pop() if loop_group_stack else None)
            prev_id = cf["id"]
            continue
        if structure == "end_case":
            if case_stack:
                case_context = case_stack.pop()
                if case_context["pending_tail"]:
                    case_context["branch_tails"].append(case_context["pending_tail"])
                tails = case_context["branch_tails"] or [case_context["case_id"]]
                for tail in tails:
                    add_edge(tail, cf["id"])
            else:
                add_edge(prev_id, cf["id"])
            end_group(branch_group_stack.pop() if branch_group_stack else None)
            prev_id = cf["id"]
            continue
        if structure == "end_if":
            add_edge(prev_id, cf["id"])
            end_group(branch_group_stack.pop() if branch_group_stack else None)
            prev_id = cf["id"]
            continue

        add_edge(prev_id, cf["id"])
        prev_id = cf["id"]

    if inline_if_context:
        end_group(inline_if_context.get("group"))
        inline_if_context = None
    end_group(body_group)

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
            "groups": [group for group in groups if group["nodeIds"]],
            "language": "idl",
        },
    }
    return graph


def build_file_flowchart(file_path: str, lines: List[Any], routines: List[Any]) -> Dict[str, Any]:
    """Build a file-scoped flowchart for an IDL ``.pro`` source.

    The graph contains:
      * an ``entry`` node labelled with the file basename,
      * one compact ``function`` reference node per routine in the file,
      * an edge from entry to each routine in source order,
      * ``calls`` edges between routines that invoke other local routines.

    Top-level executable statements (lines outside any PRO/FUNCTION) are
    emitted as ``process`` nodes so files that contain a ``main`` block are
    rendered alongside their routine references.
    """
    base = os.path.basename(file_path)
    routine_lines = set()
    for routine in routines:
        for ln in range(routine.start_line, routine.end_line + 1):
            routine_lines.add(ln)

    top_level: List[Any] = []
    for sl in lines:
        if sl.is_blank or sl.is_comment:
            continue
        if sl.line_number in routine_lines:
            continue
        top_level.append(sl)

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    groups: List[Dict[str, Any]] = []

    entry_id = "entry"
    nodes.append({
        "id": entry_id,
        "kind": "entry",
        "label": base,
        "source": {"file": file_path, "line": 1, "endLine": 1},
        "metadata": {"displayLines": [base]},
    })

    body_group = {
        "id": "group_file_body",
        "kind": "function_body",
        "label": f"{base} top-level",
        "line": 1,
        "parentGroupId": None,
        "nodeIds": [entry_id],
    }
    groups.append(body_group)

    prev_id = entry_id

    for idx, sl in enumerate(top_level):
        node_id = f"top_{idx + 1}"
        label = sl.text.strip() or sl.raw_text.strip()
        nodes.append({
            "id": node_id,
            "kind": "process",
            "label": label,
            "source": {"file": file_path, "line": sl.line_number, "endLine": sl.line_number},
            "metadata": {"displayLines": [label], "indentLevel": 0},
        })
        body_group["nodeIds"].append(node_id)
        edges.append({
            "id": f"e_top_{idx}",
            "from": prev_id,
            "to": node_id,
            "kind": "control_flow",
        })
        prev_id = node_id

    routines_group = {
        "id": "group_file_routines",
        "kind": "function_body",
        "label": f"{base} routines",
        "line": routines[0].start_line if routines else 1,
        "parentGroupId": None,
        "nodeIds": [],
    }
    if routines:
        groups.append(routines_group)

    routine_node_ids: Dict[str, str] = {}
    for idx, routine in enumerate(routines):
        node_id = f"routine_{idx + 1}"
        kind_label = "FUNCTION" if routine.kind == "function" else "PRO"
        param_text = f"({', '.join(routine.params)})" if routine.params else ""
        label = f"{kind_label} {routine.name}{param_text}"
        nodes.append({
            "id": node_id,
            "kind": "function",
            "label": label,
            "source": {
                "file": file_path,
                "line": routine.start_line,
                "endLine": routine.end_line,
            },
            "metadata": {
                "scope": "file_function_ref",
                "displayLines": [label],
                "indentLevel": 0,
                "routine": routine.name,
                "routineKind": routine.kind,
            },
        })
        routines_group["nodeIds"].append(node_id)
        edges.append({
            "id": f"e_routine_{idx}",
            "from": entry_id if idx == 0 else f"routine_{idx}",
            "to": node_id,
            "kind": "control_flow",
            "label": "declares" if idx == 0 else "then",
        })
        routine_node_ids[routine.name.upper()] = node_id

    # Add cross-routine call edges discovered from the parser.
    from idl_parser import extract_calls
    seen_call_edges = set()
    for routine in routines:
        src_id = routine_node_ids.get(routine.name.upper())
        if not src_id:
            continue
        for call in extract_calls(routine.body_lines):
            target_id = routine_node_ids.get(call.name.upper())
            if not target_id or target_id == src_id:
                continue
            key = (src_id, target_id)
            if key in seen_call_edges:
                continue
            seen_call_edges.add(key)
            edges.append({
                "id": f"e_call_{len(edges)}",
                "from": src_id,
                "to": target_id,
                "kind": "calls",
                "label": "calls",
            })

    return {
        "graphType": "flowchart",
        "title": f"File flowchart: {base}",
        "subtitle": file_path,
        "nodes": nodes,
        "edges": edges,
        "rootNodeIds": [entry_id],
        "metadata": {
            "scope": "file",
            "language": "idl",
            "fileScope": file_path,
            "groups": [g for g in groups if g["nodeIds"]],
            "routineCount": len(routines),
            "topLevelCount": len(top_level),
        },
    }


def collapse_statement_runs(cf_nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Collapse consecutive simple process/compute nodes into single nodes.

    Matches the Python flowchart builder's flush_run() behavior: up to 3 lines
    shown, then '... +N more'.  Keeps control-flow structures untouched.
    """
    result: List[Dict[str, Any]] = []
    run: List[Dict[str, Any]] = []

    def flush() -> None:
        if not run:
            return
        if len(run) == 1:
            result.append(run[0])
        else:
            display = []
            for item in run[:3]:
                display.extend(item.get("displayLines", [item.get("label", "")]))
            if len(run) > 3:
                display.append(f"... +{len(run) - 3} more")
            has_compute = any(item.get("kind") == "compute" for item in run)
            merged = dict(run[0])
            merged["kind"] = "compute" if has_compute else "process"
            merged["label"] = "\n".join(display)
            merged["displayLines"] = display
            result.append(merged)
        run.clear()

    for node in cf_nodes:
        structure = node.get("structure", "")
        kind = node.get("kind", "")
        if not structure and kind in {"process", "compute"}:
            run.append(node)
        else:
            flush()
            result.append(node)
    flush()
    return result


def compute_indent_scale(cf_nodes: List[Dict[str, Any]]) -> Tuple[int, int]:
    positive = sorted({int(node.get("indentColumn", 0)) for node in cf_nodes if int(node.get("indentColumn", 0)) > 0})
    if not positive:
        return 0, 2
    base = positive[0]
    deltas = sorted({value - base for value in positive if value > base})
    step = deltas[0] if deltas else 2
    return base, max(1, step)


def build_node_metadata(cf: Dict[str, Any], indent_base: int, indent_step: int) -> Dict[str, Any]:
    indent_column = int(cf.get("indentColumn", 0))
    indent_offset = int(cf.get("indentOffset", 0))
    display_lines = [str(line) for line in cf.get("displayLines", [cf.get("label", "")])]
    relative = 0 if indent_column <= indent_base else int((indent_column - indent_base) / max(1, indent_step))
    metadata = {
        "displayLines": display_lines,
        "indentLevel": max(0, relative + indent_offset),
    }
    type_label = infer_idl_type_label(display_lines)
    if type_label:
        metadata["typeLabel"] = type_label
    return metadata


def infer_idl_type_label(display_lines: List[str]) -> Optional[str]:
    bits: List[str] = []
    seen = set()
    for line in display_lines:
        text = str(line).strip()
        if not text:
            continue
        if text.upper().startswith("RETURN"):
            expr = text.split(",", 1)[1].strip() if "," in text else ""
            inferred = infer_idl_expr_type(expr)
            if inferred:
                bit = f"returns {inferred}"
                if bit not in seen:
                    seen.add(bit)
                    bits.append(bit)
            continue
        assign_match = re.match(r"^([A-Za-z_][\w.]*)\s*=\s*(.+)$", text)
        if assign_match:
            inferred = infer_idl_expr_type(assign_match.group(2))
            if inferred:
                bit = f"{assign_match.group(1)}: {inferred}"
                if bit not in seen:
                    seen.add(bit)
                    bits.append(bit)
    return "; ".join(bits[:4]) if bits else None


def infer_idl_expr_type(expr: str) -> Optional[str]:
    text = expr.strip()
    if not text:
        return None
    if re.match(r"^'.*'$", text):
        return "string"
    if re.match(r'^".*"$', text):
        return "string"
    if re.match(r"^\d+\.\d+(?:[eEdD][+-]?\d+)?$", text):
        return "float"
    if re.match(r"^\d+[LUSB]?$", text, re.IGNORECASE):
        return "int"
    if text.startswith("{") and text.endswith("}"):
        return "struct"
    if text.startswith("[") and text.endswith("]"):
        return "array"
    upper = text.upper()
    if any(name in upper for name in ["FLTARR(", "FINDGEN(", "FLOAT(", "MEAN(", "SQRT(", "SIN(", "COS("]):
        return "float"
    if any(name in upper for name in ["INTARR(", "LONARR(", "INDGEN(", "N_ELEMENTS(", "FIX("]):
        return "int"
    if any(name in upper for name in ["STRARR(", "STRING(", "STRMID(", "STRTRIM("]):
        return "string"
    if any(op in upper for op in [" EQ ", " NE ", " GT ", " LT ", " GE ", " LE "]):
        return "bool"
    return None


if __name__ == "__main__":
    main()
