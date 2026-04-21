#!/usr/bin/env python3
"""CodeMap Python flowchart builder.

Reads JSON on stdin: { "file": "...", "line": N }
Locates the innermost function/method whose body contains line N and emits a
flowchart GraphDocument JSON describing its control flow.

Granularity rule (per plan):
  - Linear runs of simple statements collapse into one 'process' or 'compute'.
  - if/elif/else  -> decision diamonds with control_flow edges.
    - for/while     -> loop header + body + explicit exit path.
  - try/except/finally -> decision into except branches.
  - raise         -> error node.
  - return        -> return node.

Approximate but readable. Not a full CFG.
"""

from __future__ import annotations

import ast
import json
import sys
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Union

FuncNode = Union[ast.FunctionDef, ast.AsyncFunctionDef]
LoopNode = Union[ast.For, ast.AsyncFor, ast.While]
NodeDict = Dict[str, Any]
EdgeDict = Dict[str, Any]
GraphDoc = Dict[str, Any]


@dataclass
class BuildResult:
    fallthrough: Optional[str]
    breaks: List[str] = field(default_factory=list)
    continues: List[str] = field(default_factory=list)


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
    def __init__(
        self,
        file_path: str,
        symbol: Optional[Dict[str, Any]] = None,
        symbols_by_id: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> None:
        self.file_path: str = file_path
        self.nodes: List[NodeDict] = []
        self.edges: List[EdgeDict] = []
        self.groups: List[Dict[str, Any]] = []
        self.group_stack: List[str] = []
        self._counter: int = 0
        self.var_types: Dict[str, str] = {}
        self.return_type: Optional[str] = None
        self.symbol = symbol or {}
        self.symbols_by_id = symbols_by_id or {}
        self.call_return_types: Dict[Tuple[int, int], str] = {}
        self.call_return_types_by_text: Dict[Tuple[int, str], str] = {}
        self.member_return_types: Dict[Tuple[str, str], str] = {}
        self.attribute_types: Dict[Tuple[str, str], str] = {}
        for target in self.symbols_by_id.values():
            if target.get("kind") == "method" and target.get("className"):
                return_type = target.get("returnType")
                if return_type:
                    self.member_return_types[(str(target.get("className")), str(target.get("name")))] = return_type
            if target.get("kind") == "class":
                class_name = str(target.get("name") or "")
                for attr in (target.get("classAttributes") or []) + (target.get("instanceAttributes") or []):
                    if isinstance(attr, dict) and attr.get("name") and attr.get("type"):
                        self.attribute_types[(class_name, str(attr.get("name")))] = str(attr.get("type"))
        for call in self.symbol.get("calls", []) or []:
            resolved_to = call.get("resolvedTo")
            if not resolved_to:
                continue
            target = self.symbols_by_id.get(resolved_to)
            if not target:
                continue
            return_type = target.get("returnType")
            if not return_type and target.get("kind") == "class":
                return_type = target.get("name")
            if return_type:
                line_no = int(call.get("line", 0))
                col_no = int(call.get("column", 0))
                self.call_return_types[(line_no, col_no)] = return_type
                call_text = str(call.get("text") or "")
                if call_text:
                    self.call_return_types_by_text[(line_no, call_text)] = return_type

    def _id(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}_{self._counter}"

    def _add_node(
        self,
        kind: str,
        label: str,
        line: int,
        detail: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        nid = self._id(kind)
        self.nodes.append({
            "id": nid,
            "kind": kind,
            "label": label,
            "detail": detail,
            "source": {"file": self.file_path, "line": line},
            "metadata": metadata or {},
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

    def _begin_group(self, kind: str, label: str, line: int) -> Dict[str, Any]:
        group_id = self._id("group")
        group = {
            "id": group_id,
            "kind": kind,
            "label": label,
            "line": line,
            "parentGroupId": self.group_stack[-1] if self.group_stack else None,
        }
        self.group_stack.append(group_id)
        return group

    def _end_group(self, group: Dict[str, Any], start_index: int, exclude_ids: Optional[List[str]] = None) -> None:
        if self.group_stack and self.group_stack[-1] == group["id"]:
            self.group_stack.pop()
        exclude = set(exclude_ids or [])
        node_ids = [node["id"] for node in self.nodes[start_index:] if node["id"] not in exclude]
        if not node_ids:
            return
        group["nodeIds"] = node_ids
        self.groups.append(group)

    def build(self, func: FuncNode) -> Tuple[GraphDoc, str]:
        name = func.name
        params = _extract_params(func, self.symbol)
        self.var_types = {p["name"]: p["type"] for p in params if p.get("type")}
        self.var_types.update(_collect_local_types(
            func,
            self.call_return_types,
            self.call_return_types_by_text,
            self.member_return_types,
            self.attribute_types,
        ))
        self.return_type = self.symbol.get("returnType") or _annotation_text(func.returns)
        doc_summary = self.symbol.get("docSummary")
        signature = _format_signature(name, params, self.return_type)
        entry = self._add_node(
            "entry",
            name,
            func.lineno,
            detail=signature,
            metadata={
                "params": params,
                "returnType": self.return_type,
                "docSummary": doc_summary,
                "displayLines": [name, signature] if signature else [name],
            },
        )
        body_group = self._begin_group("function_body", f"{name} body", func.lineno)
        body_start = len(self.nodes)
        terminal = self._build_block(func.body, entry)
        if terminal.fallthrough is not None:
            ret = self._add_node(
                "return",
                "implicit return",
                getattr(func, "end_lineno", func.lineno),
                metadata={
                    "returnType": self.return_type,
                    "typeLabel": f"returns {self.return_type}" if self.return_type else "",
                },
            )
            self._add_edge(terminal.fallthrough, ret)
        self._end_group(body_group, body_start)
        return ({
            "graphType": "flowchart",
            "title": f"{name}()",
            "subtitle": f"{self.file_path}:{func.lineno}",
            "nodes": self.nodes,
            "edges": self.edges,
            "rootNodeIds": [entry],
            "metadata": {
                "function": name,
                "params": params,
                "returnType": self.return_type,
                "groups": self.groups,
            },
        }, name)

    # Build a block of statements. Returns the id of the last node, or None
    # if control does not fall through (return/raise/break/continue).
    def _build_block(self, stmts: List[ast.stmt], prev: Optional[str]) -> BuildResult:
        # Group consecutive simple statements into one 'process'.
        run: List[ast.stmt] = []
        last = prev
        breaks: List[str] = []
        continues: List[str] = []

        def flush_run() -> Optional[str]:
            nonlocal run, last
            if not run:
                return last
            label = self._summarize_run(run)
            kind = "compute" if any(_is_compute(s) for s in run) else "process"
            type_label = self._summarize_types(run)
            nid = self._add_node(
                kind,
                label,
                run[0].lineno,
                metadata={"typeLabel": type_label} if type_label else None,
            )
            if last is not None:
                self._add_edge(last, nid)
            last = nid
            run = []
            return last

        for stmt in stmts:
            if isinstance(stmt, (ast.If,)):
                flush_run()
                branch = self._build_if(stmt, last)
                last = branch.fallthrough
                breaks.extend(branch.breaks)
                continues.extend(branch.continues)
                if last is None:
                    return BuildResult(None, breaks=breaks, continues=continues)
            elif isinstance(stmt, (ast.For, ast.AsyncFor, ast.While)):
                flush_run()
                loop_result = self._build_loop(stmt, last)
                last = loop_result.fallthrough
                breaks.extend(loop_result.breaks)
                continues.extend(loop_result.continues)
                if last is None:
                    return BuildResult(None, breaks=breaks, continues=continues)
            elif isinstance(stmt, ast.Try):
                flush_run()
                try_result = self._build_try(stmt, last)
                last = try_result.fallthrough
                breaks.extend(try_result.breaks)
                continues.extend(try_result.continues)
                if last is None:
                    return BuildResult(None, breaks=breaks, continues=continues)
            elif hasattr(ast, "Match") and isinstance(stmt, getattr(ast, "Match")):
                flush_run()
                match_result = self._build_match(stmt, last)
                last = match_result.fallthrough
                breaks.extend(match_result.breaks)
                continues.extend(match_result.continues)
                if last is None:
                    return BuildResult(None, breaks=breaks, continues=continues)
            elif isinstance(stmt, ast.With) or isinstance(stmt, ast.AsyncWith):
                flush_run()
                label = "with " + ", ".join(_with_text(i) for i in stmt.items)
                nid = self._add_node("process", label, stmt.lineno)
                if last is not None:
                    self._add_edge(last, nid)
                body_result = self._build_block(stmt.body, nid)
                last = body_result.fallthrough
                breaks.extend(body_result.breaks)
                continues.extend(body_result.continues)
                if last is None:
                    return BuildResult(None, breaks=breaks, continues=continues)
            elif isinstance(stmt, ast.Return):
                flush_run()
                lbl = "return " + (_short(stmt.value) if stmt.value else "")
                inferred = _infer_expr_type(
                    stmt.value,
                    self.var_types,
                    self.call_return_types,
                    self.call_return_types_by_text,
                    self.member_return_types,
                    self.attribute_types,
                )
                ret_type = inferred or self.return_type
                nid = self._add_node(
                    "return",
                    lbl.strip(),
                    stmt.lineno,
                    metadata={
                        "returnType": ret_type,
                        "typeLabel": f"returns {ret_type}" if ret_type else "",
                    },
                )
                if last is not None:
                    self._add_edge(last, nid)
                return BuildResult(None, breaks=breaks, continues=continues)
            elif isinstance(stmt, ast.Raise):
                flush_run()
                lbl = "raise " + (_short(stmt.exc) if stmt.exc else "")
                nid = self._add_node("error", lbl.strip(), stmt.lineno)
                if last is not None:
                    self._add_edge(last, nid)
                return BuildResult(None, breaks=breaks, continues=continues)
            elif isinstance(stmt, ast.Break):
                flush_run()
                nid = self._add_node("break", "break", stmt.lineno, metadata={"displayLines": ["break"]})
                if last is not None:
                    self._add_edge(last, nid)
                breaks.append(nid)
                return BuildResult(None, breaks=breaks, continues=continues)
            elif isinstance(stmt, ast.Continue):
                flush_run()
                nid = self._add_node("continue", "continue", stmt.lineno, metadata={"displayLines": ["continue"]})
                if last is not None:
                    self._add_edge(last, nid)
                continues.append(nid)
                return BuildResult(None, breaks=breaks, continues=continues)
            else:
                run.append(stmt)
        flush_run()
        return BuildResult(last, breaks=breaks, continues=continues)

    def _build_if(self, stmt: ast.If, prev: Optional[str]) -> BuildResult:
        test_text = _short(stmt.test)
        cond = "if " + test_text + "?"
        dec = self._add_node("decision", cond, stmt.lineno)
        if prev is not None:
            self._add_edge(prev, dec)

        then_group = self._begin_group("branch", _branch_group_label(test_text, "then"), stmt.body[0].lineno if stmt.body else stmt.lineno)
        then_start = len(self.nodes)
        then_result = self._build_block(stmt.body, dec)
        self._end_group(then_group, then_start)
        self._relabel_first_edge(dec, "yes")

        else_result = BuildResult(dec)
        if stmt.orelse:
            else_group = self._begin_group("branch", _branch_group_label(test_text, "else"), stmt.orelse[0].lineno if stmt.orelse else stmt.lineno)
            else_start = len(self.nodes)
            # If single elif, recurse so the else block drills down into the nested branch alphabet.
            if len(stmt.orelse) == 1 and isinstance(stmt.orelse[0], ast.If):
                else_result = self._build_if(stmt.orelse[0], dec)
            else:
                else_result = self._build_block(stmt.orelse, dec)
            self._end_group(else_group, else_start)
            self._relabel_first_edge(dec, "no")

        # Connect both branches into a join node if both fall through.
        breaks = then_result.breaks + else_result.breaks
        continues = then_result.continues + else_result.continues
        if then_result.fallthrough is None and else_result.fallthrough is None:
            return BuildResult(None, breaks=breaks, continues=continues)
        join = self._add_node("process", "•", stmt.lineno)
        if then_result.fallthrough is not None:
            self._add_edge(then_result.fallthrough, join)
        if else_result.fallthrough is not None:
            if else_result.fallthrough is dec:
                self._add_edge(dec, join, "no")
            else:
                self._add_edge(else_result.fallthrough, join)
        return BuildResult(join, breaks=breaks, continues=continues)

    def _build_loop(self, stmt: LoopNode, prev: Optional[str]) -> BuildResult:
        if isinstance(stmt, ast.While):
            label = "while " + _short(stmt.test)
            type_label = ""
        else:  # for / async for
            label = "for each " + _short(stmt.target) + " in " + _short(stmt.iter)
            target_names = _target_names(stmt.target)
            loop_type = _infer_iter_item_type(
                stmt.iter,
                self.var_types,
                self.call_return_types,
                self.call_return_types_by_text,
                self.member_return_types,
                self.attribute_types,
            )
            for target_name in target_names:
                if loop_type:
                    self.var_types[target_name] = loop_type
            typed_targets = [f"{target_name}: {self.var_types[target_name]}" for target_name in target_names if target_name in self.var_types]
            type_label = ", ".join(typed_targets)
        header = self._add_node(
            "loop",
            label,
            stmt.lineno,
            metadata={
                "typeLabel": type_label,
                "displayLines": _split_loop_label(label),
            } if type_label else {"displayLines": _split_loop_label(label)},
        )
        if prev is not None:
            self._add_edge(prev, header)
        after_loop = self._add_node("process", "after loop", getattr(stmt, "end_lineno", stmt.lineno))

        body_group = self._begin_group("loop_body", _loop_block_group_label(label, "body"), stmt.body[0].lineno if stmt.body else stmt.lineno)
        body_start = len(self.nodes)
        body_result = self._build_block(stmt.body, header)
        self._end_group(body_group, body_start)

        if body_result.fallthrough is not None:
            self._add_edge(body_result.fallthrough, header, "repeat")
        for continue_node in body_result.continues:
            self._add_edge(continue_node, header, "continue")
        for break_node in body_result.breaks:
            self._add_edge(break_node, after_loop, "break")
        if stmt.orelse:
            loop_else = self._add_node(
                "loop_else",
                "loop else",
                stmt.orelse[0].lineno,
                metadata={"displayLines": ["loop", "else"]},
            )
            self._add_edge(header, loop_else, "done")

            else_group = self._begin_group("branch", _loop_block_group_label(label, "else"), stmt.orelse[0].lineno)
            else_start = len(self.nodes)
            else_result = self._build_block(stmt.orelse, loop_else)
            self._end_group(else_group, else_start)

            for continue_node in else_result.continues:
                self._add_edge(continue_node, header, "continue")
            for break_node in else_result.breaks:
                self._add_edge(break_node, after_loop, "break")

            if else_result.fallthrough is not None:
                self._add_edge(else_result.fallthrough, after_loop)
            has_fallthrough = (
                else_result.fallthrough is not None
                or bool(body_result.breaks)
                or bool(else_result.breaks)
            )
            return BuildResult(after_loop if has_fallthrough else None)
        self._add_edge(header, after_loop, "done")
        return BuildResult(after_loop)

    def _build_try(self, stmt: ast.Try, prev: Optional[str]) -> BuildResult:
        guard = self._add_node("decision", "try", stmt.lineno)
        if prev is not None:
            self._add_edge(prev, guard)
        try_result = self._build_block(stmt.body, guard)
        handler_results: List[BuildResult] = []
        for handler in stmt.handlers:
            etype = _short(handler.type) if handler.type else "Exception"
            h = self._add_node("error", f"except {etype}", handler.lineno)
            self._add_edge(guard, h, "raise")
            handler_results.append(self._build_block(handler.body, h))
        fallthroughs = []
        if try_result.fallthrough is not None:
            fallthroughs.append((try_result.fallthrough, "ok"))
        for result in handler_results:
            if result.fallthrough is not None:
                fallthroughs.append((result.fallthrough, ""))
        breaks = list(try_result.breaks)
        continues = list(try_result.continues)
        for result in handler_results:
            breaks.extend(result.breaks)
            continues.extend(result.continues)
        if not fallthroughs:
            return BuildResult(None, breaks=breaks, continues=continues)
        join = self._add_node("process", "•", stmt.lineno)
        for src, label in fallthroughs:
            self._add_edge(src, join, label)
        if stmt.finalbody:
            fin = self._add_node("process", "finally", stmt.finalbody[0].lineno)
            self._add_edge(join, fin)
            fin_result = self._build_block(stmt.finalbody, fin)
            breaks.extend(fin_result.breaks)
            continues.extend(fin_result.continues)
            return BuildResult(fin_result.fallthrough, breaks=breaks, continues=continues)
        return BuildResult(join, breaks=breaks, continues=continues)

    def _build_match(self, stmt: Any, prev: Optional[str]) -> BuildResult:
        """Handle Python 3.10+ match/case statements."""
        subject_text = _short(stmt.subject)
        group = self._begin_group("branch", f"match {subject_text}", stmt.lineno)
        start_index = len(self.nodes)
        dec = self._add_node("decision", f"match {subject_text}", stmt.lineno, metadata={
            "displayLines": [f"match {subject_text}"],
        })
        if prev is not None:
            self._add_edge(prev, dec)
        breaks: List[str] = []
        continues: List[str] = []
        case_results: List[BuildResult] = []
        for case_node in stmt.cases:
            pattern_text = _short(case_node.pattern) if hasattr(case_node, "pattern") else "case"
            guard_text = ""
            if hasattr(case_node, "guard") and case_node.guard:
                guard_text = f" if {_short(case_node.guard)}"
            case_label = f"case {pattern_text}{guard_text}"
            case_id = self._add_node("decision", case_label, case_node.lineno, metadata={
                "displayLines": [case_label],
            })
            self._add_edge(dec, case_id, "")
            body_result = self._build_block(case_node.body, case_id)
            case_results.append(body_result)
            breaks.extend(body_result.breaks)
            continues.extend(body_result.continues)
        fallthroughs = [r.fallthrough for r in case_results if r.fallthrough is not None]
        if not fallthroughs:
            self._end_group(group, start_index)
            return BuildResult(None, breaks=breaks, continues=continues)
        join = self._add_node("process", "•", stmt.lineno)
        for ft in fallthroughs:
            self._add_edge(ft, join)
        self._end_group(group, start_index)
        return BuildResult(join, breaks=breaks, continues=continues)

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

    def _summarize_types(self, run: List[ast.stmt]) -> str:
        typed: List[str] = []
        for stmt in run:
            typed.extend(_statement_type_bits(
                stmt,
                self.var_types,
                self.call_return_types,
                self.call_return_types_by_text,
                self.member_return_types,
                self.attribute_types,
            ))
        if not typed:
            return ""
        unique: List[str] = []
        seen = set()
        for item in typed:
            if item not in seen:
                unique.append(item)
                seen.add(item)
        if len(unique) > 3:
            return "; ".join(unique[:3]) + f"; +{len(unique) - 3} more"
        return "; ".join(unique)


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


def _annotation_text(node: Optional[ast.AST]) -> Optional[str]:
    if node is None:
        return None
    text = _short(node)
    return text or None


def _extract_params(func: FuncNode, symbol: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    symbol_params = {
        param.get("name"): param
        for param in ((symbol or {}).get("params", []) or [])
        if isinstance(param, dict) and param.get("name")
    }
    params: List[Dict[str, Any]] = []
    for arg in list(func.args.posonlyargs) + list(func.args.args):
        entry: Dict[str, Any] = {"name": arg.arg}
        arg_type = symbol_params.get(arg.arg, {}).get("type") or _annotation_text(arg.annotation)
        if arg_type:
            entry["type"] = arg_type
        params.append(entry)
    if func.args.vararg is not None:
        entry = {"name": func.args.vararg.arg, "vararg": True}
        arg_type = symbol_params.get(func.args.vararg.arg, {}).get("type") or _annotation_text(func.args.vararg.annotation)
        if arg_type:
            entry["type"] = arg_type
        params.append(entry)
    for arg in func.args.kwonlyargs:
        entry = {"name": arg.arg, "kwOnly": True}
        arg_type = symbol_params.get(arg.arg, {}).get("type") or _annotation_text(arg.annotation)
        if arg_type:
            entry["type"] = arg_type
        params.append(entry)
    if func.args.kwarg is not None:
        entry = {"name": func.args.kwarg.arg, "kwarg": True}
        arg_type = symbol_params.get(func.args.kwarg.arg, {}).get("type") or _annotation_text(func.args.kwarg.annotation)
        if arg_type:
            entry["type"] = arg_type
        params.append(entry)
    return params


def _format_signature(name: str, params: List[Dict[str, Any]], return_type: Optional[str]) -> str:
    parts: List[str] = []
    for param in params:
        label = param["name"]
        if param.get("vararg"):
            label = "*" + label
        if param.get("kwarg"):
            label = "**" + label
        if param.get("type"):
            label += f": {param['type']}"
        parts.append(label)
    signature = f"({', '.join(parts)})"
    if return_type:
        signature += f" -> {return_type}"
    return signature


def _split_loop_label(label: str) -> List[str]:
    if label.startswith("for each ") and " in " in label:
        head, tail = label.split(" in ", 1)
        return [head, "in " + tail]
    if label.startswith("while "):
        return ["while", label[len("while "):]]
    return [label]


def _branch_group_label(test_text: str, branch: str) -> str:
    return f"{branch}: {test_text}"


def _loop_block_group_label(loop_label: str, block_kind: str) -> str:
    return f"{block_kind}: {loop_label}"


class _LocalTypeCollector(ast.NodeVisitor):
    def __init__(
        self,
        call_return_types: Dict[Tuple[int, int], str],
        call_return_types_by_text: Dict[Tuple[int, str], str],
        member_return_types: Dict[Tuple[str, str], str],
        attribute_types: Dict[Tuple[str, str], str],
    ) -> None:
        self.types: Dict[str, str] = {}
        self.call_return_types = call_return_types
        self.call_return_types_by_text = call_return_types_by_text
        self.member_return_types = member_return_types
        self.attribute_types = attribute_types

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        return

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        return

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        return

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        ann = _annotation_text(node.annotation)
        if ann:
            for name in _target_names(node.target):
                self.types[name] = ann
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:
        inferred = _infer_expr_type(
            node.value,
            self.types,
            self.call_return_types,
            self.call_return_types_by_text,
            self.member_return_types,
            self.attribute_types,
        )
        if inferred:
            for target in node.targets:
                # Tuple unpacking: a, b = func() where func returns tuple[X, Y]
                if isinstance(target, (ast.Tuple, ast.List)):
                    elem_types = _parse_tuple_element_types(inferred)
                    if elem_types:
                        names = _target_names(target)
                        for i, name in enumerate(names):
                            if i < len(elem_types):
                                self.types[name] = elem_types[i]
                        continue
                # Dict subscript assignment: d[key] = value
                if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name):
                    dict_name = target.value.id
                    dict_type = self.types.get(dict_name)
                    if dict_type and _base_type_name(dict_type) == "dict":
                        key_type = _infer_expr_type(
                            target.slice,
                            self.types,
                            self.call_return_types,
                            self.call_return_types_by_text,
                            self.member_return_types,
                            self.attribute_types,
                        )
                        if key_type and inferred:
                            refined = _refine_dict_type(dict_type, key_type, inferred)
                            if refined:
                                self.types[dict_name] = refined
                    continue
                for name in _target_names(target):
                    self.types[name] = inferred
        self.generic_visit(node)

    def visit_Expr(self, node: ast.Expr) -> None:
        if isinstance(node.value, ast.Call):
            _apply_container_mutation(
                node.value,
                self.types,
                self.call_return_types,
                self.call_return_types_by_text,
                self.member_return_types,
                self.attribute_types,
            )
        self.generic_visit(node)

    def visit_For(self, node: ast.For) -> None:
        inferred = _infer_iter_item_type(
            node.iter,
            self.types,
            self.call_return_types,
            self.call_return_types_by_text,
            self.member_return_types,
            self.attribute_types,
        )
        if inferred:
            for name in _target_names(node.target):
                self.types[name] = inferred
        self.generic_visit(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        inferred = _infer_iter_item_type(
            node.iter,
            self.types,
            self.call_return_types,
            self.call_return_types_by_text,
            self.member_return_types,
            self.attribute_types,
        )
        if inferred:
            for name in _target_names(node.target):
                self.types[name] = inferred
        self.generic_visit(node)


def _collect_local_types(
    func: FuncNode,
    call_return_types: Dict[Tuple[int, int], str],
    call_return_types_by_text: Dict[Tuple[int, str], str],
    member_return_types: Dict[Tuple[str, str], str],
    attribute_types: Dict[Tuple[str, str], str],
) -> Dict[str, str]:
    collector = _LocalTypeCollector(
        call_return_types,
        call_return_types_by_text,
        member_return_types,
        attribute_types,
    )
    for stmt in func.body:
        collector.visit(stmt)
    return collector.types


def _target_names(node: ast.AST) -> List[str]:
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, (ast.Tuple, ast.List)):
        names: List[str] = []
        for elt in node.elts:
            names.extend(_target_names(elt))
        return names
    return []


def _statement_type_bits(
    stmt: ast.stmt,
    known_types: Dict[str, str],
    call_return_types: Dict[Tuple[int, int], str],
    call_return_types_by_text: Dict[Tuple[int, str], str],
    member_return_types: Dict[Tuple[str, str], str],
    attribute_types: Dict[Tuple[str, str], str],
) -> List[str]:
    if isinstance(stmt, ast.AnnAssign):
        ann = _annotation_text(stmt.annotation)
        if ann:
            return [f"{name}: {ann}" for name in _target_names(stmt.target)]
    if isinstance(stmt, ast.Assign):
        inferred = _infer_expr_type(
            stmt.value,
            known_types,
            call_return_types,
            call_return_types_by_text,
            member_return_types,
            attribute_types,
        )
        if inferred:
            bits: List[str] = []
            for target in stmt.targets:
                # Tuple unpacking
                if isinstance(target, (ast.Tuple, ast.List)):
                    elem_types = _parse_tuple_element_types(inferred)
                    if elem_types:
                        names = _target_names(target)
                        for i, name in enumerate(names):
                            if i < len(elem_types):
                                bits.append(f"{name}: {elem_types[i]}")
                        continue
                # Dict subscript assignment
                if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name):
                    dict_name = target.value.id
                    dict_type = known_types.get(dict_name)
                    if dict_type and _base_type_name(dict_type) == "dict":
                        key_type = _infer_expr_type(
                            target.slice,
                            known_types,
                            call_return_types,
                            call_return_types_by_text,
                            member_return_types,
                            attribute_types,
                        )
                        if key_type and inferred:
                            refined = _refine_dict_type(dict_type, key_type, inferred)
                            if refined:
                                bits.append(f"{dict_name}: {refined}")
                    continue
                bits.extend(f"{name}: {inferred}" for name in _target_names(target))
            # Add attribute access type bits from RHS
            bits.extend(_attribute_access_bits(stmt.value, known_types, attribute_types))
            return bits
    if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
        refined = _container_mutation_bits(
            stmt.value,
            known_types,
            call_return_types,
            call_return_types_by_text,
            member_return_types,
            attribute_types,
        )
        if refined:
            return refined
    if isinstance(stmt, (ast.For, ast.AsyncFor)):
        inferred = _infer_iter_item_type(
            stmt.iter,
            known_types,
            call_return_types,
            call_return_types_by_text,
            member_return_types,
            attribute_types,
        )
        if inferred:
            return [f"{name}: {inferred}" for name in _target_names(stmt.target)]
    # Fallback: scan for attribute accesses in any statement
    stmt_attr_bits = _attribute_access_bits(stmt, known_types, attribute_types)
    if stmt_attr_bits:
        return stmt_attr_bits
    return []


def _infer_iter_item_type(
    node: ast.AST,
    known_types: Dict[str, str],
    call_return_types: Dict[Tuple[int, int], str],
    call_return_types_by_text: Dict[Tuple[int, str], str],
    member_return_types: Dict[Tuple[str, str], str],
    attribute_types: Dict[Tuple[str, str], str],
) -> Optional[str]:
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "range":
        return "int"
    inferred = _infer_expr_type(
        node,
        known_types,
        call_return_types,
        call_return_types_by_text,
        member_return_types,
        attribute_types,
    )
    if not inferred:
        return None
    if inferred.startswith("list[") and inferred.endswith("]"):
        return inferred[5:-1]
    if inferred.startswith("tuple[") and inferred.endswith("]"):
        inner = inferred[6:-1]
        parts = _split_type_args(inner)
        if len(parts) == 1:
            return parts[0]
        return None  # heterogeneous tuple, can't determine single item type
    if inferred.startswith("dict[") and inferred.endswith("]"):
        parts = _split_type_args(inferred[5:-1])
        if parts:
            return parts[0]  # iterating a dict yields keys
    if inferred.startswith("set[") and inferred.endswith("]"):
        return inferred[4:-1]
    return None


def _infer_expr_type(
    node: Optional[ast.AST],
    known_types: Dict[str, str],
    call_return_types: Dict[Tuple[int, int], str],
    call_return_types_by_text: Dict[Tuple[int, str], str],
    member_return_types: Dict[Tuple[str, str], str],
    attribute_types: Dict[Tuple[str, str], str],
) -> Optional[str]:
    if node is None:
        return None
    if isinstance(node, ast.Constant):
        if node.value is None:
            return "None"
        return type(node.value).__name__
    if isinstance(node, ast.Name):
        return known_types.get(node.id)
    if isinstance(node, ast.Attribute):
        receiver_type = _infer_expr_type(
            node.value,
            known_types,
            call_return_types,
            call_return_types_by_text,
            member_return_types,
            attribute_types,
        )
        if receiver_type:
            return attribute_types.get((_base_type_name(receiver_type), node.attr))
        return None
    if isinstance(node, ast.List):
        item_type = _infer_expr_type(node.elts[0], known_types, call_return_types, call_return_types_by_text, member_return_types, attribute_types) if node.elts else "Any"
        if node.elts and not item_type:
            return None
        return f"list[{item_type}]"
    if isinstance(node, ast.Tuple):
        if not node.elts:
            return "tuple[Any]"
        elem_types = [_infer_expr_type(e, known_types, call_return_types, call_return_types_by_text, member_return_types, attribute_types) for e in node.elts]
        if any(t is None for t in elem_types):
            return None
        return f"tuple[{', '.join(elem_types)}]"
    if isinstance(node, ast.Set):
        item_type = _infer_expr_type(node.elts[0], known_types, call_return_types, call_return_types_by_text, member_return_types, attribute_types) if node.elts else "Any"
        if node.elts and not item_type:
            return None
        return f"set[{item_type}]"
    if isinstance(node, ast.Dict):
        if not node.keys:
            return "dict[Any, Any]"
        key_type = _infer_expr_type(node.keys[0], known_types, call_return_types, call_return_types_by_text, member_return_types, attribute_types) if node.keys[0] is not None else None
        val_type = _infer_expr_type(node.values[0], known_types, call_return_types, call_return_types_by_text, member_return_types, attribute_types)
        if not key_type or not val_type:
            return "dict[Any, Any]"
        return f"dict[{key_type}, {val_type}]"
    if isinstance(node, ast.JoinedStr):
        return "str"
    if isinstance(node, ast.Compare):
        return "bool"
    if isinstance(node, ast.UnaryOp):
        return _infer_expr_type(node.operand, known_types, call_return_types, call_return_types_by_text, member_return_types, attribute_types)
    if isinstance(node, ast.BinOp):
        left = _infer_expr_type(node.left, known_types, call_return_types, call_return_types_by_text, member_return_types, attribute_types)
        right = _infer_expr_type(node.right, known_types, call_return_types, call_return_types_by_text, member_return_types, attribute_types)
        if left == right and left:
            return left
        if left in {"int", "float"} and right in {"int", "float"}:
            return "float" if "float" in {left, right} else "int"
        return left or right
    if isinstance(node, ast.Call):
        if hasattr(node, "lineno") and hasattr(node, "col_offset"):
            resolved = call_return_types.get((int(node.lineno), int(node.col_offset)))
            if resolved:
                return resolved
        call_text = _call_text(node)
        if call_text:
            resolved = call_return_types_by_text.get((int(getattr(node, "lineno", 0)), call_text))
            if resolved:
                return resolved
        inferred_member_return = _infer_method_call_type(node, known_types, member_return_types)
        if inferred_member_return:
            return inferred_member_return
        if isinstance(node.func, ast.Name):
            known = {
                "str": "str",
                "int": "int",
                "float": "float",
                "bool": "bool",
                "list": "list[Any]",
                "dict": "dict[Any, Any]",
                "set": "set[Any]",
                "tuple": "tuple[Any]",
            }
            return known.get(node.func.id)
        return None
    return None


def _infer_method_call_type(
    node: ast.Call,
    known_types: Dict[str, str],
    member_return_types: Dict[Tuple[str, str], str],
) -> Optional[str]:
    if not isinstance(node.func, ast.Attribute):
        return None
    receiver_type = _infer_simple_name_type(node.func.value, known_types)
    if not receiver_type:
        return None
    return member_return_types.get((_base_type_name(receiver_type), node.func.attr))


def _infer_simple_name_type(node: ast.AST, known_types: Dict[str, str]) -> Optional[str]:
    if isinstance(node, ast.Name):
        return known_types.get(node.id)
    return None


def _base_type_name(type_name: str) -> str:
    if "[" in type_name:
        return type_name.split("[", 1)[0]
    return type_name


def _container_mutation_bits(
    call: ast.Call,
    known_types: Dict[str, str],
    call_return_types: Dict[Tuple[int, int], str],
    call_return_types_by_text: Dict[Tuple[int, str], str],
    member_return_types: Dict[Tuple[str, str], str],
    attribute_types: Dict[Tuple[str, str], str],
) -> List[str]:
    refined = _apply_container_mutation(
        call,
        known_types,
        call_return_types,
        call_return_types_by_text,
        member_return_types,
        attribute_types,
    )
    return [refined] if refined else []


def _apply_container_mutation(
    call: ast.Call,
    known_types: Dict[str, str],
    call_return_types: Dict[Tuple[int, int], str],
    call_return_types_by_text: Dict[Tuple[int, str], str],
    member_return_types: Dict[Tuple[str, str], str],
    attribute_types: Dict[Tuple[str, str], str],
) -> str:
    if not isinstance(call.func, ast.Attribute) or not isinstance(call.func.value, ast.Name):
        return ""
    container_name = call.func.value.id
    container_type = known_types.get(container_name)
    if not container_type:
        return ""
    method = call.func.attr
    if method in {"append", "add"} and call.args:
        item_type = _infer_expr_type(
            call.args[0],
            known_types,
            call_return_types,
            call_return_types_by_text,
            member_return_types,
            attribute_types,
        )
        if not item_type:
            return ""
        refined = _refine_container_type(container_type, item_type)
        if refined and refined != container_type:
            known_types[container_name] = refined
        return f"{container_name}: {known_types.get(container_name, container_type)}"
    if method == "extend" and call.args:
        item_type = _infer_iter_item_type(
            call.args[0],
            known_types,
            call_return_types,
            call_return_types_by_text,
            member_return_types,
            attribute_types,
        )
        if not item_type:
            return ""
        refined = _refine_container_type(container_type, item_type)
        if refined and refined != container_type:
            known_types[container_name] = refined
        return f"{container_name}: {known_types.get(container_name, container_type)}"
    if method == "update" and call.args:
        arg_type = _infer_expr_type(
            call.args[0],
            known_types,
            call_return_types,
            call_return_types_by_text,
            member_return_types,
            attribute_types,
        )
        if arg_type and _base_type_name(container_type) == "dict" and _base_type_name(arg_type) == "dict":
            # Merge dict types: refine Any slots from the argument dict
            arg_parts = _split_type_args(arg_type[5:-1]) if arg_type.startswith("dict[") and arg_type.endswith("]") else []
            if len(arg_parts) == 2:
                refined = _refine_dict_type(container_type, arg_parts[0], arg_parts[1])
                if refined:
                    known_types[container_name] = refined
        elif arg_type and arg_type != container_type:
            known_types[container_name] = arg_type if container_type in {"dict", "dict[Any, Any]"} else container_type
        return f"{container_name}: {known_types.get(container_name, container_type)}"
    return ""


def _refine_container_type(container_type: str, item_type: str) -> Optional[str]:
    if container_type.startswith("list[") and container_type.endswith("]"):
        current = container_type[5:-1]
        if current == "Any" or current == item_type:
            return f"list[{item_type}]"
        return container_type
    if container_type.startswith("set[") and container_type.endswith("]"):
        current = container_type[4:-1]
        if current == "Any" or current == item_type:
            return f"set[{item_type}]"
        return container_type
    if container_type == "list[Any]":
        return f"list[{item_type}]"
    if container_type == "set[Any]":
        return f"set[{item_type}]"
    return None


def _refine_dict_type(dict_type: str, key_type: str, val_type: str) -> Optional[str]:
    """Refine a dict type with observed key/value types."""
    if dict_type.startswith("dict[") and dict_type.endswith("]"):
        parts = _split_type_args(dict_type[5:-1])
        if len(parts) == 2:
            cur_k, cur_v = parts
            new_k = key_type if cur_k == "Any" else cur_k
            new_v = val_type if cur_v == "Any" else cur_v
            return f"dict[{new_k}, {new_v}]"
    if dict_type == "dict":
        return f"dict[{key_type}, {val_type}]"
    return None


def _parse_tuple_element_types(type_str: str) -> Optional[List[str]]:
    """Parse tuple[X, Y, Z] into individual element types."""
    if not type_str.startswith("tuple[") or not type_str.endswith("]"):
        return None
    inner = type_str[6:-1]
    parts = _split_type_args(inner)
    if len(parts) <= 1:
        return None  # single-element tuple, not unpacking
    return parts


def _split_type_args(s: str) -> List[str]:
    """Split comma-separated type arguments respecting nested brackets."""
    parts: List[str] = []
    depth = 0
    current: List[str] = []
    for ch in s:
        if ch in "([":
            depth += 1
            current.append(ch)
        elif ch in ")]":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    if current:
        parts.append("".join(current).strip())
    return parts


def _attribute_access_bits(
    node: ast.AST,
    known_types: Dict[str, str],
    attribute_types: Dict[Tuple[str, str], str],
) -> List[str]:
    """Scan an AST node for attribute accesses and return type bits."""
    bits: List[str] = []
    seen: set = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Attribute) and isinstance(child.value, ast.Name):
            receiver_type = known_types.get(child.value.id)
            if receiver_type:
                attr_type = attribute_types.get((_base_type_name(receiver_type), child.attr))
                if attr_type:
                    key = f"{child.value.id}.{child.attr}"
                    if key not in seen:
                        bits.append(f"{key}: {attr_type}")
                        seen.add(key)
    return bits


def _call_text(node: ast.Call) -> str:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        return _short(node.func)
    return ""


def _find_analysis_symbol(
    analysis: Optional[Dict[str, Any]],
    file_path: str,
    line: int,
) -> Optional[Dict[str, Any]]:
    if not analysis:
        return None
    symbols = analysis.get("symbols") or {}
    file_norm = os.path.normcase(os.path.abspath(file_path))
    candidates: List[Dict[str, Any]] = []
    for symbol in symbols.values():
        if symbol.get("kind") not in {"function", "method"}:
            continue
        symbol_file = symbol.get("file")
        if not symbol_file:
            continue
        if os.path.normcase(os.path.abspath(symbol_file)) != file_norm:
            continue
        source = symbol.get("source") or {}
        start = int(source.get("line", 0) or 0)
        end = int(source.get("endLine", start) or start)
        if start <= line <= end:
            candidates.append(symbol)
    if not candidates:
        return None
    candidates.sort(key=lambda sym: int((sym.get("source") or {}).get("line", 0) or 0), reverse=True)
    return candidates[0]


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
    analysis = req.get("analysis")
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
    symbol = _find_analysis_symbol(analysis, file_path, line)
    symbols_by_id = (analysis or {}).get("symbols") or {}
    builder = FlowBuilder(file_path, symbol=symbol, symbols_by_id=symbols_by_id)
    doc, _name = builder.build(func)
    emit(doc)


def emit(data: Any) -> None:
    sys.stdout.write(json.dumps(data))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
