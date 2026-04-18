#!/usr/bin/env python3
"""CodeMap Python flowchart builder.

Reads JSON on stdin: { "file": "...", "line": N }
Locates the innermost function/method whose body contains line N and emits a
flowchart GraphDocument JSON describing its control flow.

Granularity rule (per plan):
  - Linear runs of simple statements collapse into one 'process' or 'compute'.
  - if/elif/else  -> decision diamonds with control_flow edges.
  - for/while     -> decision (loop header) + body + back-edge.
  - try/except/finally -> decision into except branches.
  - raise         -> error node.
  - return        -> return node.

Approximate but readable. Not a full CFG.
"""

from __future__ import annotations

import ast
import json
import sys
from typing import Any, Dict, List, Optional, Tuple, Union

FuncNode = Union[ast.FunctionDef, ast.AsyncFunctionDef]
LoopNode = Union[ast.For, ast.AsyncFor, ast.While]
NodeDict = Dict[str, Any]
EdgeDict = Dict[str, Any]
GraphDoc = Dict[str, Any]


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
    # Pick innermost (largest start line that still contains line).
    candidates.sort(key=lambda n: n.lineno, reverse=True)
    return candidates[0]


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------

class FlowBuilder:
    def __init__(self, file_path: str) -> None:
        self.file_path: str = file_path
        self.nodes: List[NodeDict] = []
        self.edges: List[EdgeDict] = []
        self._counter: int = 0

    def _id(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}_{self._counter}"

    def _add_node(self, kind: str, label: str, line: int, detail: str = "") -> str:
        nid = self._id(kind)
        self.nodes.append({
            "id": nid,
            "kind": kind,
            "label": label,
            "detail": detail,
            "source": {"file": self.file_path, "line": line},
        })
        return nid

    def _add_edge(self, src: str, dst: str, label: str = "") -> None:
        self.edges.append({
            "id": f"e_{src}_{dst}_{len(self.edges)}",
            "from": src,
            "to": dst,
            "kind": "control_flow",
            "label": label,
        })

    def build(self, func: FuncNode) -> Tuple[GraphDoc, str]:
        name = func.name
        args = ", ".join(a.arg for a in func.args.args)
        entry = self._add_node("entry", f"{name}({args})", func.lineno)
        terminal = self._build_block(func.body, entry)
        if terminal is not None:
            ret = self._add_node("return", "implicit return", getattr(func, "end_lineno", func.lineno))
            self._add_edge(terminal, ret)
        return ({
            "graphType": "flowchart",
            "title": f"{name}()",
            "subtitle": f"{self.file_path}:{func.lineno}",
            "nodes": self.nodes,
            "edges": self.edges,
            "rootNodeIds": [entry],
            "metadata": {"function": name},
        }, name)

    # Build a block of statements. Returns the id of the last node, or None
    # if control does not fall through (return/raise/break/continue).
    def _build_block(self, stmts: List[ast.stmt], prev: Optional[str]) -> Optional[str]:
        # Group consecutive simple statements into one 'process'.
        run: List[ast.stmt] = []
        last = prev

        def flush_run() -> Optional[str]:
            nonlocal run, last
            if not run:
                return last
            label = self._summarize_run(run)
            kind = "compute" if any(_is_compute(s) for s in run) else "process"
            nid = self._add_node(kind, label, run[0].lineno)
            if last is not None:
                self._add_edge(last, nid)
            last = nid
            run = []
            return last

        for stmt in stmts:
            if isinstance(stmt, (ast.If,)):
                flush_run()
                last = self._build_if(stmt, last)
            elif isinstance(stmt, (ast.For, ast.AsyncFor, ast.While)):
                flush_run()
                last = self._build_loop(stmt, last)
            elif isinstance(stmt, ast.Try):
                flush_run()
                last = self._build_try(stmt, last)
            elif isinstance(stmt, ast.With) or isinstance(stmt, ast.AsyncWith):
                flush_run()
                label = "with " + ", ".join(_with_text(i) for i in stmt.items)
                nid = self._add_node("process", label, stmt.lineno)
                if last is not None:
                    self._add_edge(last, nid)
                last = nid
                last = self._build_block(stmt.body, last)
            elif isinstance(stmt, ast.Return):
                flush_run()
                lbl = "return " + (_short(stmt.value) if stmt.value else "")
                nid = self._add_node("return", lbl.strip(), stmt.lineno)
                if last is not None:
                    self._add_edge(last, nid)
                return None
            elif isinstance(stmt, ast.Raise):
                flush_run()
                lbl = "raise " + (_short(stmt.exc) if stmt.exc else "")
                nid = self._add_node("error", lbl.strip(), stmt.lineno)
                if last is not None:
                    self._add_edge(last, nid)
                return None
            elif isinstance(stmt, (ast.Break, ast.Continue)):
                flush_run()
                lbl = "break" if isinstance(stmt, ast.Break) else "continue"
                nid = self._add_node("process", lbl, stmt.lineno)
                if last is not None:
                    self._add_edge(last, nid)
                return None
            else:
                run.append(stmt)
        flush_run()
        return last

    def _build_if(self, stmt: ast.If, prev: Optional[str]) -> Optional[str]:
        cond = "if " + _short(stmt.test) + "?"
        dec = self._add_node("decision", cond, stmt.lineno)
        if prev is not None:
            self._add_edge(prev, dec)
        then_end = self._build_block(stmt.body, dec)
        else_end: Optional[str] = dec
        else_label = "no"
        if stmt.orelse:
            # If single elif, recurse to keep chain readable.
            if len(stmt.orelse) == 1 and isinstance(stmt.orelse[0], ast.If):
                else_end = self._build_if(stmt.orelse[0], dec)
            else:
                else_end = self._build_block(stmt.orelse, dec)
        # Connect both branches into a join node if both fall through.
        if then_end is None and else_end is None:
            return None
        join = self._add_node("process", "•", stmt.lineno)
        if then_end is not None:
            # Re-label the first edge from dec to then-branch.
            self._relabel_first_edge(dec, "yes")
            self._add_edge(then_end, join)
        if else_end is not None:
            if else_end is dec:
                self._add_edge(dec, join, else_label)
            else:
                self._add_edge(else_end, join)
        return join

    def _build_loop(self, stmt: LoopNode, prev: Optional[str]) -> Optional[str]:
        if isinstance(stmt, ast.While):
            label = "while " + _short(stmt.test) + "?"
        else:  # for / async for
            label = "for " + _short(stmt.target) + " in " + _short(stmt.iter) + "?"
        header = self._add_node("decision", label, stmt.lineno)
        if prev is not None:
            self._add_edge(prev, header)
        body_end = self._build_block(stmt.body, header)
        if body_end is not None:
            self._add_edge(body_end, header, "loop")
        return header

    def _build_try(self, stmt: ast.Try, prev: Optional[str]) -> Optional[str]:
        guard = self._add_node("decision", "try", stmt.lineno)
        if prev is not None:
            self._add_edge(prev, guard)
        try_end = self._build_block(stmt.body, guard)
        join = self._add_node("process", "•", stmt.lineno)
        if try_end is not None:
            self._add_edge(try_end, join, "ok")
        for handler in stmt.handlers:
            etype = _short(handler.type) if handler.type else "Exception"
            h = self._add_node("error", f"except {etype}", handler.lineno)
            self._add_edge(guard, h, "raise")
            h_end = self._build_block(handler.body, h)
            if h_end is not None:
                self._add_edge(h_end, join)
        if stmt.finalbody:
            fin = self._add_node("process", "finally", stmt.finalbody[0].lineno)
            self._add_edge(join, fin)
            fin_end = self._build_block(stmt.finalbody, fin)
            return fin_end
        return join

    def _relabel_first_edge(self, src: str, label: str) -> None:
        for e in self.edges:
            if e["from"] == src and not e["label"]:
                e["label"] = label
                return

    def _summarize_run(self, run: List[ast.stmt]) -> str:
        # Show up to 3 lines, abbreviate the rest.
        lines = [_short(s) for s in run[:3]]
        if len(run) > 3:
            lines.append(f"... +{len(run) - 3} more")
        return "\n".join(lines)


def _is_compute(stmt: ast.stmt) -> bool:
    """Heuristic: assignment with arithmetic/numeric call on RHS."""
    if isinstance(stmt, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
        rhs = getattr(stmt, "value", None)
        if isinstance(rhs, (ast.BinOp, ast.UnaryOp, ast.Compare)):
            return True
        if isinstance(rhs, ast.Call):
            return True
    return False


def _short(node: Optional[ast.AST]) -> str:
    if node is None:
        return ""
    try:
        text = ast.unparse(node)
    except Exception:
        text = type(node).__name__
    text = text.replace("\n", " ")
    if len(text) > 60:
        text = text[:57] + "..."
    return text


def _with_text(item: ast.withitem) -> str:
    s = _short(item.context_expr)
    if item.optional_vars is not None:
        s += " as " + _short(item.optional_vars)
    return s


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

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
    builder = FlowBuilder(file_path)
    doc, _name = builder.build(func)
    emit(doc)


def emit(data: Any) -> None:
    sys.stdout.write(json.dumps(data))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
