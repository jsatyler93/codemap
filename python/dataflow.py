#!/usr/bin/env python3
"""CodeMap Python data-flow adapter.

Reads JSON from stdin:
  {"file": "...", "line": N, "analysis": {...optional...}}

Emits GraphDocument JSON with graphType="dataflow".
Nodes are line-oriented, carrying reads/writes metadata.
"""

from __future__ import annotations

import ast
import json
import os
import symtable
import sys
from typing import Any, Dict, List, Optional, Set, Tuple, Union

FuncNode = Union[ast.FunctionDef, ast.AsyncFunctionDef]


def find_target_function(tree: ast.AST, line: int) -> Optional[FuncNode]:
    candidates: List[FuncNode] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start = node.lineno
            end = getattr(node, "end_lineno", start)
            if start <= line <= end:
                candidates.append(node)
    if not candidates:
        return None
    candidates.sort(key=lambda n: n.lineno, reverse=True)
    return candidates[0]


def _collect_write_targets(node: ast.AST, out: Set[str]) -> None:
    if isinstance(node, ast.Name):
        out.add(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for elt in node.elts:
            _collect_write_targets(elt, out)
    elif isinstance(node, ast.Starred):
        _collect_write_targets(node.value, out)


def _collect_read_names(node: ast.AST, out: Set[str]) -> None:
    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
        out.add(node.id)
    for child in ast.iter_child_nodes(node):
        _collect_read_names(child, out)


def _extract_known_symbols(func_node: FuncNode, source: str, filename: str) -> Set[str]:
    known: Set[str] = set()
    try:
        segment = ast.get_source_segment(source, func_node)
        if not segment:
            return known
        table = symtable.symtable(segment, filename, "exec")
        func_table = None
        for child in table.get_children():
            if child.get_name() == func_node.name:
                func_table = child
                break
        if func_table is None:
            func_table = table
        for sym in func_table.get_symbols():
            known.add(sym.get_name())
    except Exception:
        return known
    return known


def extract_line_effects(func_node: FuncNode, source: str, filename: str) -> Dict[int, Dict[str, List[str]]]:
    known_symbols = _extract_known_symbols(func_node, source, filename)
    effects: Dict[int, Dict[str, Set[str]]] = {}

    def line_bucket(line: int) -> Dict[str, Set[str]]:
        if line not in effects:
            effects[line] = {"reads": set(), "writes": set()}
        return effects[line]

    for node in ast.walk(func_node):
        line = getattr(node, "lineno", None)
        if not isinstance(line, int):
            continue
        bucket = line_bucket(line)

        if isinstance(node, ast.Assign):
            for target in node.targets:
                _collect_write_targets(target, bucket["writes"])
        elif isinstance(node, ast.AugAssign):
            _collect_write_targets(node.target, bucket["writes"])
            _collect_read_names(node.target, bucket["reads"])
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            _collect_write_targets(node.target, bucket["writes"])
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            _collect_write_targets(node.target, bucket["writes"])
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    _collect_write_targets(item.optional_vars, bucket["writes"])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node is not func_node:
            bucket["writes"].add(node.name)
        elif isinstance(node, ast.ClassDef):
            bucket["writes"].add(node.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                bucket["writes"].add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                bucket["writes"].add(alias.asname or alias.name)
        elif isinstance(node, ast.NamedExpr):
            _collect_write_targets(node.target, bucket["writes"])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bucket["writes"].add(node.name)

        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            bucket["reads"].add(node.id)

    out: Dict[int, Dict[str, List[str]]] = {}
    for line, item in effects.items():
        reads = sorted(item["reads"])
        writes = sorted(item["writes"])
        if known_symbols:
            reads = [r for r in reads if r in known_symbols]
            writes = [w for w in writes if w in known_symbols]
        out[line] = {"reads": reads, "writes": writes}
    return out


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" \t"))


def classify_line(stripped: str, lineno: int, parent_group: Optional[str]) -> Tuple[str, Optional[Dict[str, Any]]]:
    if not stripped:
        return "blank", None
    if stripped.startswith("#"):
        return "comment", None
    if stripped.startswith("@"):
        return "decorator", None

    def start(kind: str, gid: str, summary: str) -> Tuple[str, Dict[str, Any]]:
        return kind, {
            "groupId": gid,
            "role": "start",
            "summary": summary,
            "parentGroup": parent_group,
        }

    if stripped.startswith("for ") and stripped.endswith(":"):
        return start("loop", f"loop-L{lineno}", stripped[:-1])
    if stripped.startswith("while ") and stripped.endswith(":"):
        return start("loop", f"while-L{lineno}", stripped[:-1])
    if stripped.startswith("if ") and stripped.endswith(":"):
        return start("branch", f"if-L{lineno}", stripped[:-1])
    if stripped.startswith("elif ") and stripped.endswith(":"):
        return start("branch", f"elif-L{lineno}", stripped[:-1])
    if stripped == "else:" or stripped.startswith("else:"):
        return start("branch", f"else-L{lineno}", "else")
    if stripped.startswith("try") and stripped.endswith(":"):
        return start("try_block", f"try-L{lineno}", "try")
    if stripped.startswith("except") and stripped.endswith(":"):
        return start("try_block", f"except-L{lineno}", stripped[:-1])
    if stripped.startswith("finally") and stripped.endswith(":"):
        return start("try_block", f"finally-L{lineno}", "finally")
    if stripped.startswith("with ") and stripped.endswith(":"):
        return start("assign", f"with-L{lineno}", stripped[:-1])
    if stripped.startswith("def ") and stripped.endswith(":"):
        return start("func_def", f"def-L{lineno}", stripped[:-1])
    if stripped.startswith("class ") and stripped.endswith(":"):
        return start("class_def", f"class-L{lineno}", stripped[:-1])
    if stripped.startswith("match ") and stripped.endswith(":"):
        return start("branch", f"match-L{lineno}", stripped[:-1])
    if stripped.startswith("case ") and stripped.endswith(":"):
        return start("match_arm", f"case-L{lineno}", stripped[:-1])

    if stripped.startswith("return"):
        return "return", None
    if stripped.startswith("import ") or stripped.startswith("from "):
        return "import", None

    aug_ops = ["+=", "-=", "*=", "/=", "//=", "**=", "%=", "&=", "|=", "^=", "<<=", ">>="]
    if any(op in stripped for op in aug_ops):
        return "augassign", None
    if "=" in stripped and not stripped.startswith("="):
        return "assign", None
    return "call", None


def _node_kind_for_graph(kind: str) -> str:
    # Map line classifier kinds to current GraphNode kinds to stay compatible
    if kind in {"loop"}:
        return "loop"
    if kind in {"branch", "match_arm"}:
        return "decision"
    if kind in {"return"}:
        return "return"
    if kind in {"try_block"}:
        return "error"
    if kind in {"blank", "comment"}:
        return "process"
    return "process"


def _func_params(func_node: FuncNode) -> List[str]:
    params: List[str] = []
    for arg in list(func_node.args.posonlyargs) + list(func_node.args.args):
        params.append(arg.arg)
    if func_node.args.vararg is not None:
        params.append(func_node.args.vararg.arg)
    for arg in func_node.args.kwonlyargs:
        params.append(arg.arg)
    if func_node.args.kwarg is not None:
        params.append(func_node.args.kwarg.arg)
    return params


def build_dataflow_graph(func_node: FuncNode, source: str, file_path: str) -> Dict[str, Any]:
    source_lines = source.splitlines()
    line_effects = extract_line_effects(func_node, source, file_path)

    start_line = func_node.lineno
    end_line = getattr(func_node, "end_lineno", start_line)
    func_line = source_lines[start_line - 1] if 0 <= start_line - 1 < len(source_lines) else f"def {func_node.name}(...)"
    func_indent = _indent_of(func_line)

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []

    params = _func_params(func_node)
    root_id = f"L{start_line}"
    nodes.append({
        "id": root_id,
        "kind": "entry",
        "label": func_line.strip(),
        "source": {"file": file_path, "line": start_line, "endLine": start_line},
        "metadata": {
            "line": start_line,
            "depth": 0,
            "code": func_line,
            "reads": [],
            "writes": params,
            "lang": "py",
            "groupId": "func-body",
            "groupRole": "start",
            "summary": f"def {func_node.name}({', '.join(params)})",
        },
    })

    # Stack entries: {groupId, indent}
    group_stack: List[Dict[str, Any]] = [{"groupId": "func-body", "indent": func_indent}]
    prev_id = root_id

    for lineno in range(start_line + 1, end_line + 1):
        if lineno - 1 >= len(source_lines):
            break
        raw = source_lines[lineno - 1]
        stripped = raw.strip()
        indent = _indent_of(raw)

        while len(group_stack) > 1 and indent <= group_stack[-1]["indent"] and stripped:
            group_stack.pop()

        parent_group = group_stack[-1]["groupId"] if group_stack else None
        kind, group_info = classify_line(stripped, lineno, parent_group)
        mapped_kind = _node_kind_for_graph(kind)

        depth = 0
        if stripped:
            depth = max(0, (indent - func_indent - 4) // 4 + 1)

        fx = line_effects.get(lineno, {"reads": [], "writes": []})
        metadata: Dict[str, Any] = {
            "line": lineno,
            "depth": depth,
            "code": raw,
            "reads": fx["reads"],
            "writes": fx["writes"],
            "lang": "py",
        }

        if group_info:
            metadata["groupId"] = group_info["groupId"]
            metadata["groupRole"] = "start"
            metadata["summary"] = group_info.get("summary", stripped)
            if group_info.get("parentGroup"):
                metadata["parentGroup"] = group_info["parentGroup"]
            group_stack.append({"groupId": group_info["groupId"], "indent": indent})
        elif parent_group:
            metadata["groupId"] = parent_group

        node_id = f"L{lineno}"
        nodes.append({
            "id": node_id,
            "kind": mapped_kind,
            "label": stripped,
            "source": {"file": file_path, "line": lineno, "endLine": lineno},
            "metadata": metadata,
        })

        if stripped and kind not in {"blank", "comment"}:
            edges.append({
                "id": f"cf-{prev_id}-{node_id}",
                "from": prev_id,
                "to": node_id,
                "kind": "control_flow",
            })
            prev_id = node_id

    return {
        "graphType": "dataflow",
        "title": f"{func_node.name}()",
        "subtitle": f"Data flow - {file_path}",
        "nodes": nodes,
        "edges": edges,
        "rootNodeIds": [root_id],
        "metadata": {
            "function": func_node.name,
            "params": params,
            "file": file_path,
            "startLine": start_line,
            "endLine": end_line,
        },
    }


def emit(data: Any) -> None:
    sys.stdout.write(json.dumps(data))
    sys.stdout.flush()


def main() -> None:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        emit({"error": f"bad json: {e}"})
        return

    file_path = req.get("file")
    line = int(req.get("line", 1))
    if not file_path:
        emit({"error": "missing 'file'"})
        return

    try:
        with open(file_path, "r", encoding="utf-8") as fh:
            source = fh.read()
        tree = ast.parse(source, filename=file_path)
    except (OSError, SyntaxError, UnicodeDecodeError) as e:
        emit({"error": str(e)})
        return

    func = find_target_function(tree, line)
    if func is None:
        emit({"error": f"no function found at line {line}"})
        return

    emit(build_dataflow_graph(func, source, os.path.abspath(file_path)))


if __name__ == "__main__":
    main()
