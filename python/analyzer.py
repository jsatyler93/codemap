#!/usr/bin/env python3
"""CodeMap Python static analyzer.

Reads a JSON request on stdin, writes a JSON response on stdout.

Request shape:
  {
    "command":    "index",
    "files":      ["abs.py", ...],
    "root":       "abs/path/to/workspace",
    "useJedi":    true | false                # optional, default true
  }

Response shape mirrors PyAnalysisResult in TypeScript.

Strategy:
  - Always uses the standard library `ast` for symbol/type/call extraction.
  - Optionally upgrades unresolved/likely call sites using `jedi` if it is
    importable in the chosen interpreter. Failure to import jedi is silent.

This file is type-annotated and has no third-party dependencies for the core
path; jedi is purely optional.
"""

from __future__ import annotations

import ast
import builtins
import json
import os
import re
import sys
from typing import Any, Callable, Dict, List, Optional, Tuple

# --- shared aliases -----------------------------------------------------------

SymbolDict = Dict[str, Any]
SymbolMap = Dict[str, SymbolDict]
ModuleMap = Dict[str, str]
ImportDict = Dict[str, Any]
CallDict = Dict[str, Any]
ParamDict = Dict[str, Any]
AttrDict = Dict[str, Any]
Resolution = Tuple[str, str]  # (symbol_id, resolution_kind)
AliasInfo = Tuple[str, ...]   # ("module", mod) or ("from", mod, name)
CallResolution = Dict[str, Any]

BUILTIN_NAMES = set(dir(builtins))

# --- helpers ------------------------------------------------------------------


def module_path_from_file(file_path: str, root: str) -> str:
    """Convert an absolute file path to a dotted module path relative to root."""
    try:
        rel = os.path.relpath(file_path, root)
    except ValueError:
        rel = os.path.basename(file_path)
    rel = rel.replace("\\", "/")
    if rel.endswith(".py"):
        rel = rel[:-3]
    if rel.endswith("/__init__"):
        rel = rel[: -len("/__init__")]
    return rel.replace("/", ".") if rel else "<root>"


def _resolve_relative(owning_module: str, target: str, level: int) -> str:
    """Apply Python's relative-import rules."""
    if level <= 0:
        return target
    parts = owning_module.split(".")
    base = parts[: max(0, len(parts) - level)]
    if target:
        base = base + target.split(".")
    return ".".join(p for p in base if p)


def _unparse(node: Optional[ast.AST]) -> Optional[str]:
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return None


def _short_unparse(node: Optional[ast.AST]) -> Optional[str]:
    s = _unparse(node)
    if s is None:
        return None
    s = s.replace("\n", " ")
    return (s[:80] + "...") if len(s) > 80 else s


def call_text(node: ast.AST) -> str:
    """Return source-ish text for a call expression's func."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f"{call_text(node.value)}.{node.attr}"
    if isinstance(node, ast.Call):
        return call_text(node.func) + "(...)"
    if isinstance(node, ast.Subscript):
        return call_text(node.value) + "[...]"
    return type(node).__name__


def call_lookup_column(node: ast.AST) -> int:
    """Choose a column that points at the callable symbol itself.

    For attribute calls like `obj.method()`, Jedi is much more reliable when we
    point at the attribute name rather than the start of the whole expression.
    """
    end_col = getattr(node, "end_col_offset", None)
    if isinstance(end_col, int) and end_col > 0:
        return end_col - 1
    return getattr(node, "col_offset", 0)


# --- docstring type parsing ---------------------------------------------------

_NUMPY_SECTIONS = {
    "parameters", "returns", "yields", "raises", "notes",
    "examples", "see also", "references", "attributes",
}


def _strip_section_marker(line: str) -> str:
    return line.rstrip(":").strip().lower()


def parse_docstring_types(docstring: Optional[str]) -> Tuple[Dict[str, str], Optional[str]]:
    """Parse parameter and return types from a docstring.

    Supports two common conventions:
      - NumPy:  blocks under 'Parameters'/'Returns' headings followed by '----'.
      - Google: blocks under 'Args:'/'Returns:' with 'name (type): description'.

    Returns (param_types, return_type).
    """
    if not docstring:
        return {}, None
    params: Dict[str, str] = {}
    ret: Optional[str] = None

    lines = docstring.splitlines()
    section: Optional[str] = None  # "params" | "returns" | None

    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        marker = _strip_section_marker(stripped)

        # NumPy-style section header followed by --- underline.
        if marker in _NUMPY_SECTIONS and i + 1 < len(lines) and set(lines[i + 1].strip()) <= {"-"}:
            if marker == "parameters":
                section = "params"
            elif marker in ("returns", "yields"):
                section = "returns"
            else:
                section = None
            i += 2
            continue

        # Google-style headers.
        if stripped.lower() in ("args:", "arguments:", "parameters:"):
            section = "params"
            i += 1
            continue
        if stripped.lower() in ("returns:", "yields:"):
            section = "returns"
            i += 1
            continue
        if stripped.lower() in ("raises:", "examples:", "notes:", "attributes:"):
            section = None
            i += 1
            continue

        if section == "params":
            # NumPy: "name : type"
            m = re.match(r"^(\w+)\s*:\s*(.+?)(?:,\s*optional)?\s*$", stripped)
            if m:
                params[m.group(1)] = m.group(2).strip()
            else:
                # Google: "name (type): description"
                m = re.match(r"^(\w+)\s*\(([^)]+)\)\s*:", stripped)
                if m:
                    params[m.group(1)] = m.group(2).strip()
        elif section == "returns":
            if stripped:
                # NumPy single-line "type" or "name : type"
                m = re.match(r"^(\w+)\s*:\s*(.+)$", stripped)
                if m:
                    ret = m.group(2).strip()
                else:
                    ret = stripped
                section = None
        i += 1

    return params, ret


# --- per-file extraction ------------------------------------------------------


class FileExtractor(ast.NodeVisitor):
    def __init__(self, file_path: str, module: str) -> None:
        self.file_path: str = file_path
        self.module: str = module
        self.symbols: SymbolMap = {}
        self.imports: List[ImportDict] = []
        self.scope: List[Tuple[str, str]] = []
        self.stats = {"functions": 0, "classes": 0, "type_slots": 0, "typed_slots": 0}

    def run(self, tree: ast.Module) -> None:
        module_id = f"{self.module}:<module>"
        self.symbols[module_id] = {
            "id": module_id,
            "kind": "module",
            "name": self.module.split(".")[-1] or self.module,
            "qualifiedName": "<module>",
            "module": self.module,
            "file": self.file_path,
            "source": {"file": self.file_path, "line": 1, "column": 0},
            "calls": [],
            "members": [],
            "topLevel": [],
            "imports": [],
            "docSummary": _doc_summary(ast.get_docstring(tree)),
        }
        for stmt in tree.body:
            if isinstance(stmt, (ast.Import, ast.ImportFrom)):
                self._record_import(stmt)
            self.visit(stmt)
        self.symbols[module_id]["imports"] = self.imports

    def _record_import(self, node: ast.AST) -> None:
        if isinstance(node, ast.Import):
            for alias in node.names:
                self.imports.append({
                    "module": alias.name,
                    "asName": alias.asname,
                    "names": [],
                    "line": node.lineno,
                    "isFrom": False,
                    "level": 0,
                })
        elif isinstance(node, ast.ImportFrom):
            self.imports.append({
                "module": node.module or "",
                "asName": None,
                "names": [{"name": a.name, "asName": a.asname} for a in node.names],
                "line": node.lineno,
                "isFrom": True,
                "level": node.level or 0,
            })

    def _qualified_name(self, name: str) -> str:
        return ".".join(s[1] for s in self.scope) + ("." if self.scope else "") + name

    def _make_id(self, qualified_name: str) -> str:
        return f"{self.module}:{qualified_name}"

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        qname = self._qualified_name(node.name)
        sid = self._make_id(qname)
        bases = [s for s in (_unparse(b) for b in node.bases) if s is not None]
        class_attrs: List[AttrDict] = []
        for stmt in node.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                class_attrs.append({
                    "name": stmt.target.id,
                    "type": _unparse(stmt.annotation),
                    "typeSource": "annotation",
                    "typeConfidence": "high",
                    "line": stmt.lineno,
                })
        instance_attrs = _collect_self_attrs(node)
        self.symbols[sid] = {
            "id": sid,
            "kind": "class",
            "name": node.name,
            "qualifiedName": qname,
            "module": self.module,
            "file": self.file_path,
            "source": _src(node, self.file_path),
            "decorators": [_short_unparse(d) or "" for d in node.decorator_list],
            "bases": bases,
            "classAttributes": class_attrs,
            "instanceAttributes": instance_attrs,
            "calls": [],
            "members": [],
            "docSummary": _doc_summary(ast.get_docstring(node)),
        }
        self.stats["classes"] += 1
        if not self.scope:
            self.symbols[f"{self.module}:<module>"]["topLevel"].append(sid)
        self.scope.append(("class", node.name))
        try:
            for stmt in node.body:
                self.visit(stmt)
        finally:
            self.scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._handle_function(node, is_async=False)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._handle_function(node, is_async=True)

    def _handle_function(self, node: ast.AST, is_async: bool) -> None:
        name: str = node.name  # type: ignore[attr-defined]
        qname = self._qualified_name(name)
        sid = self._make_id(qname)
        in_class = bool(self.scope and self.scope[-1][0] == "class")
        kind = "method" if in_class else "function"

        decorators_src = [_short_unparse(d) or "" for d in node.decorator_list]  # type: ignore[attr-defined]
        method_kind = _classify_method(decorators_src) if in_class else None

        docstring = ast.get_docstring(node)
        doc_params, doc_ret = parse_docstring_types(docstring)

        params = _extract_params(node, in_class, method_kind, doc_params)
        return_type = _unparse(node.returns)  # type: ignore[attr-defined]
        return_type_source: Optional[str] = "annotation" if return_type else None
        return_type_confidence: Optional[str] = "high" if return_type else None
        if not return_type and doc_ret:
            return_type = doc_ret
            return_type_source = "docstring"
            return_type_confidence = "medium"

        # Type-coverage stats: count each param + the return as a slot.
        for p in params:
            self.stats["type_slots"] += 1
            if p.get("type"):
                self.stats["typed_slots"] += 1
        self.stats["type_slots"] += 1
        if return_type:
            self.stats["typed_slots"] += 1

        symbol: SymbolDict = {
            "id": sid,
            "kind": kind,
            "name": name,
            "qualifiedName": qname,
            "module": self.module,
            "file": self.file_path,
            "source": _src(node, self.file_path),
            "decorators": decorators_src,
            "isAsync": is_async,
            "params": params,
            "returnType": return_type,
            "returnTypeSource": return_type_source,
            "returnTypeConfidence": return_type_confidence,
            "docSummary": _doc_summary(docstring),
            "calls": [],
        }
        if in_class:
            symbol["className"] = self.scope[-1][1]
            symbol["methodKind"] = method_kind or "instance"
            class_id = self._make_id(".".join(s[1] for s in self.scope))
            self.symbols[class_id]["members"].append(sid)
        else:
            self.symbols[f"{self.module}:<module>"]["topLevel"].append(sid)

        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                symbol["calls"].append({
                    "text": call_text(child.func),
                    "line": getattr(child, "lineno", 0),
                    "column": call_lookup_column(child.func),
                    "resolution": "unresolved",
                    "resolutionSource": "unresolved",
                    "confidence": "low",
                })

        self.symbols[sid] = symbol
        self.stats["functions"] += 1

        self.scope.append(("func", name))
        try:
            for stmt in node.body:  # type: ignore[attr-defined]
                if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    self.visit(stmt)
        finally:
            self.scope.pop()


def _src(node: ast.AST, file_path: str) -> Dict[str, Any]:
    return {
        "file": file_path,
        "line": getattr(node, "lineno", 1),
        "column": getattr(node, "col_offset", 0),
        "endLine": getattr(node, "end_lineno", None),
        "endColumn": getattr(node, "end_col_offset", None),
    }


def _doc_summary(docstring: Optional[str]) -> Optional[str]:
    if not docstring:
        return None
    for line in docstring.splitlines():
        s = line.strip()
        if s:
            return s
    return None


def _classify_method(decorators_src: List[str]) -> str:
    for d in decorators_src:
        head = d.split("(", 1)[0].strip()
        if head.endswith("staticmethod"):
            return "static"
        if head.endswith("classmethod"):
            return "class"
        if head.endswith("property") or head.endswith(".setter") or head.endswith(".getter") or head.endswith(".deleter"):
            return "property"
    return "instance"


def _extract_params(
    node: ast.AST,
    in_class: bool,
    method_kind: Optional[str],
    doc_params: Dict[str, str],
) -> List[ParamDict]:
    args = node.args  # type: ignore[attr-defined]
    out: List[ParamDict] = []

    # Skip self/cls for instance/class methods.
    skip_first = in_class and method_kind in (None, "instance", "class", "property")

    pos_args = list(args.args)
    n_no_default = len(pos_args) - len(args.defaults)
    for i, a in enumerate(pos_args):
        if i == 0 and skip_first and a.arg in ("self", "cls"):
            continue
        ann = _unparse(a.annotation)
        di = i - n_no_default
        default = _short_unparse(args.defaults[di]) if di >= 0 else None
        out.append(_mk_param(a.arg, ann, doc_params, default=default))

    if args.vararg is not None:
        ann = _unparse(args.vararg.annotation)
        p = _mk_param(args.vararg.arg, ann, doc_params)
        p["vararg"] = True
        out.append(p)

    for a, d in zip(args.kwonlyargs, args.kw_defaults):
        ann = _unparse(a.annotation)
        p = _mk_param(a.arg, ann, doc_params, default=_short_unparse(d) if d else None)
        p["kwOnly"] = True
        out.append(p)

    if args.kwarg is not None:
        ann = _unparse(args.kwarg.annotation)
        p = _mk_param(args.kwarg.arg, ann, doc_params)
        p["kwarg"] = True
        out.append(p)

    return out


def _mk_param(
    name: str,
    annotation: Optional[str],
    doc_params: Dict[str, str],
    default: Optional[str] = None,
) -> ParamDict:
    p: ParamDict = {"name": name}
    if annotation:
        p["type"] = annotation
        p["typeSource"] = "annotation"
        p["typeConfidence"] = "high"
    elif name in doc_params:
        p["type"] = doc_params[name]
        p["typeSource"] = "docstring"
        p["typeConfidence"] = "medium"
    if default is not None:
        p["default"] = default
    return p


def _collect_self_attrs(class_node: ast.ClassDef) -> List[AttrDict]:
    """Heuristic: find attributes assigned on `self.` inside __init__."""
    attrs: List[AttrDict] = []
    seen: set = set()
    init = next(
        (s for s in class_node.body
         if isinstance(s, ast.FunctionDef) and s.name == "__init__"),
        None,
    )
    if init is None:
        return attrs
    for n in ast.walk(init):
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Attribute):
            t = n.target
            if isinstance(t.value, ast.Name) and t.value.id == "self" and t.attr not in seen:
                seen.add(t.attr)
                attrs.append({
                    "name": t.attr,
                    "type": _unparse(n.annotation),
                    "typeSource": "annotation",
                    "typeConfidence": "high",
                    "line": n.lineno,
                })
        elif isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self":
                    if t.attr in seen:
                        continue
                    seen.add(t.attr)
                    inferred = _infer_value_type(n.value)
                    attrs.append({
                        "name": t.attr,
                        "type": inferred,
                        "typeSource": "value-inference" if inferred else None,
                        "typeConfidence": "low" if inferred else None,
                        "line": n.lineno,
                    })
    return attrs


def _infer_value_type(value: ast.AST) -> Optional[str]:
    if isinstance(value, ast.Constant):
        return type(value.value).__name__
    if isinstance(value, ast.List):
        return "list"
    if isinstance(value, ast.Dict):
        return "dict"
    if isinstance(value, ast.Set):
        return "set"
    if isinstance(value, ast.Tuple):
        return "tuple"
    if isinstance(value, ast.Call):
        return _short_unparse(value.func)
    return None


# --- cross-file resolution ----------------------------------------------------


def resolve_calls(symbols: SymbolMap, modules: ModuleMap) -> None:
    """Best-effort static name resolution. Conservative: leaves unknown calls
    as 'unresolved' rather than inventing edges."""

    module_locals: Dict[str, Dict[str, str]] = {}
    for sid, sym in symbols.items():
        if sym["kind"] in ("function", "class"):
            qname = sym["qualifiedName"]
            if "." not in qname:
                module_locals.setdefault(sym["module"], {})[sym["name"]] = sid

    module_aliases: Dict[str, Dict[str, AliasInfo]] = {}
    for sym in symbols.values():
        if sym["kind"] != "module":
            continue
        owning_mod = sym["module"]
        amap: Dict[str, AliasInfo] = {}
        for imp in sym.get("imports", []):
            src_mod = _resolve_relative(owning_mod, imp["module"], imp["level"])
            if not imp["isFrom"]:
                top = src_mod.split(".")[0]
                if imp["asName"]:
                    amap[imp["asName"]] = ("module", src_mod)
                else:
                    amap[top] = ("module", src_mod)
            else:
                for n in imp["names"]:
                    alias = n["asName"] or n["name"]
                    amap[alias] = ("from", src_mod, n["name"])
        module_aliases[sym["module"]] = amap

    class_methods: Dict[str, Dict[str, str]] = {}
    for sid, sym in symbols.items():
        if sym["kind"] == "class":
            mmap: Dict[str, str] = {}
            for member_id in sym.get("members", []):
                m = symbols.get(member_id)
                if m:
                    mmap[m["name"]] = member_id
            class_methods[sid] = mmap

    for sym in symbols.values():
        if sym["kind"] not in ("function", "method"):
            continue
        mod = sym["module"]
        locals_map = module_locals.get(mod, {})
        aliases = module_aliases.get(mod, {})
        owning_class_id: Optional[str] = None
        if sym["kind"] == "method":
            cls_qname = sym["qualifiedName"].rsplit(".", 1)[0]
            owning_class_id = f"{mod}:{cls_qname}"
        for call in sym["calls"]:
            target = _resolve_one(
                call["text"], locals_map, aliases, modules, symbols,
                owning_class_id, class_methods,
            )
            if target:
                call.update(target)


def _resolve_one(
    text: str,
    locals_map: Dict[str, str],
    aliases: Dict[str, AliasInfo],
    modules: ModuleMap,
    symbols: SymbolMap,
    owning_class_id: Optional[str],
    class_methods: Dict[str, Dict[str, str]],
) -> Optional[CallResolution]:
    if not text:
        return None
    head, *rest = text.split(".")

    if head in ("self", "cls") and rest and owning_class_id:
        method_name = rest[0]
        mid = class_methods.get(owning_class_id, {}).get(method_name)
        if mid:
            return _call_resolution(
                resolved_to=mid,
                resolution="resolved" if head == "self" else "likely",
                resolution_source="ast-self-member" if head == "self" else "ast-class-member",
                confidence="high" if head == "self" else "medium",
            )
        return None

    if not rest and head in locals_map:
        return _call_resolution(
            resolved_to=locals_map[head],
            resolution="resolved",
            resolution_source="ast-local",
            confidence="high",
        )

    if head in aliases:
        ainfo = aliases[head]
        if ainfo[0] == "from":
            _, src_mod, orig = ainfo
            if not rest:
                cand = f"{src_mod}:{orig}"
                if cand in symbols:
                    return _call_resolution(
                        resolved_to=cand,
                        resolution="resolved",
                        resolution_source="ast-import-from",
                        confidence="high",
                    )
                return _out_of_scope_resolution(f"{src_mod}.{orig}", src_mod in modules)
            class_cand = f"{src_mod}:{orig}"
            if class_cand in symbols and symbols[class_cand]["kind"] == "class":
                mid = class_methods.get(class_cand, {}).get(rest[0])
                if mid:
                    return _call_resolution(
                        resolved_to=mid,
                        resolution="likely",
                        resolution_source="ast-imported-class-member",
                        confidence="medium",
                    )
            return _out_of_scope_resolution(".".join([src_mod, orig, *rest]), src_mod in modules)
        if ainfo[0] == "module":
            target_mod = ainfo[1]
            if rest:
                cand = f"{target_mod}:{rest[0]}"
                if cand in symbols:
                    return _call_resolution(
                        resolved_to=cand,
                        resolution="resolved",
                        resolution_source="ast-import-module",
                        confidence="high",
                    )
                if len(rest) >= 2:
                    class_id = f"{target_mod}:{rest[0]}"
                    if class_id in symbols and symbols[class_id]["kind"] == "class":
                        mid = class_methods.get(class_id, {}).get(rest[1])
                        if mid:
                            return _call_resolution(
                                resolved_to=mid,
                                resolution="likely",
                                resolution_source="ast-imported-class-member",
                                confidence="medium",
                            )
            return _out_of_scope_resolution(".".join([target_mod, *rest]), target_mod in modules)

    if rest and head in locals_map:
        cls_id = locals_map[head]
        if symbols.get(cls_id, {}).get("kind") == "class":
            mid = class_methods.get(cls_id, {}).get(rest[0])
            if mid:
                return _call_resolution(
                    resolved_to=mid,
                    resolution="likely",
                    resolution_source="ast-class-member",
                    confidence="medium",
                )
    if head in BUILTIN_NAMES:
        return _call_resolution(
            resolution="unresolved",
            resolution_source="builtin",
            confidence="high",
            external_target=text,
        )
    return None


def _call_resolution(
    *,
    resolution: str,
    resolution_source: str,
    confidence: str,
    resolved_to: Optional[str] = None,
    external_target: Optional[str] = None,
) -> CallResolution:
    out: CallResolution = {
        "resolution": resolution,
        "resolutionSource": resolution_source,
        "confidence": confidence,
    }
    if resolved_to is not None:
        out["resolvedTo"] = resolved_to
    if external_target is not None:
        out["externalTarget"] = external_target
    return out


def _out_of_scope_resolution(target_text: str, analyzed_module_present: bool) -> CallResolution:
    return _call_resolution(
        resolution="unresolved",
        resolution_source="out-of-scope-import" if not analyzed_module_present else "import-miss",
        confidence="medium" if not analyzed_module_present else "low",
        external_target=target_text,
    )


# --- optional: jedi-backed upgrade -------------------------------------------


def try_jedi_upgrade(symbols: SymbolMap, files: List[str], project_root: str) -> int:
    """If `jedi` is installed, try to upgrade unresolved/likely call sites by
    consulting Jedi's goto. Returns the number of call sites improved.

    Failure to import jedi or any error is silent; the caller may inspect the
    returned count to decide whether to surface it in the UI.
    """
    try:
        import jedi  # type: ignore
    except Exception:
        return 0

    try:
        project = jedi.Project(project_root)
    except Exception:
        return 0

    # Build file -> Script cache lazily.
    script_cache: Dict[str, Any] = {}

    def get_script(file_path: str):
        sc = script_cache.get(file_path)
        if sc is not None:
            return sc
        try:
            sc = jedi.Script(path=file_path, project=project)
            script_cache[file_path] = sc
            return sc
        except Exception:
            return None

    # symbol_id -> set of (module, qualified_name) variants for matching.
    upgraded = 0
    for sym in symbols.values():
        if sym["kind"] not in ("function", "method"):
            continue
        for call in sym["calls"]:
            if call["resolution"] == "resolved":
                continue
            sc = get_script(sym["file"])
            if sc is None:
                continue
            try:
                defs = sc.infer(line=call["line"], column=call["column"])
                if not defs:
                    defs = sc.goto(line=call["line"], column=call["column"], follow_imports=True)
            except Exception:
                continue
            cand = _jedi_to_symbol_id(defs, symbols)
            if cand:
                call["resolvedTo"] = cand
                call["resolution"] = "resolved"
                call["resolutionSource"] = "jedi"
                call["confidence"] = "high"
                upgraded += 1
    return upgraded


def _jedi_to_symbol_id(defs: List[Any], symbols: SymbolMap) -> Optional[str]:
    """Pick the first jedi Definition that maps to a known symbol id."""
    for d in defs:
        try:
            mod_path = getattr(d, "module_path", None)
            full = getattr(d, "full_name", None)
            name = getattr(d, "name", None)
            line = getattr(d, "line", None)
        except Exception:
            continue
        if mod_path:
            for sid, sym in symbols.items():
                if sym["file"] != str(mod_path):
                    continue
                joined = f"{sym['module']}.{sym['qualifiedName']}" if sym["qualifiedName"] != "<module>" else sym["module"]
                if full and joined == full:
                    return sid
                if line is not None and sym["source"]["line"] == line and (name is None or sym["name"] == name):
                    return sid
        if full:
            for sid, sym in symbols.items():
                joined = f"{sym['module']}.{sym['qualifiedName']}" if sym["qualifiedName"] != "<module>" else sym["module"]
                if joined == full:
                    return sid
    return None


# --- driver ------------------------------------------------------------------


def index_files(files: List[str], root: str, use_jedi: bool = True) -> Dict[str, Any]:
    symbols: SymbolMap = {}
    modules: ModuleMap = {}
    errors: List[Dict[str, str]] = []
    agg = {"functions": 0, "classes": 0, "type_slots": 0, "typed_slots": 0}
    for f in files:
        try:
            with open(f, "r", encoding="utf-8") as fh:
                source = fh.read()
            tree = ast.parse(source, filename=f)
        except (OSError, SyntaxError, UnicodeDecodeError) as e:
            errors.append({"file": f, "message": str(e)})
            continue
        mod = module_path_from_file(f, root)
        ex = FileExtractor(f, mod)
        ex.run(tree)
        symbols.update(ex.symbols)
        modules[mod] = f"{mod}:<module>"
        for k in agg:
            agg[k] += ex.stats[k]

    resolve_calls(symbols, modules)
    jedi_upgraded = try_jedi_upgrade(symbols, files, root) if use_jedi else 0
    jedi_enabled = use_jedi and _jedi_available()

    call_summary = {
        "total": 0,
        "resolved": 0,
        "likely": 0,
        "unresolved": 0,
        "builtin": 0,
        "outOfScope": 0,
        "jedi": 0,
    }
    for sym in symbols.values():
        if sym["kind"] not in ("function", "method"):
            continue
        for call in sym["calls"]:
            call_summary["total"] += 1
            resolution = call.get("resolution", "unresolved")
            if resolution in call_summary:
                call_summary[resolution] += 1
            source = call.get("resolutionSource")
            if source == "builtin":
                call_summary["builtin"] += 1
            elif source == "out-of-scope-import":
                call_summary["outOfScope"] += 1
            elif source == "jedi":
                call_summary["jedi"] += 1

    coverage = (agg["typed_slots"] / agg["type_slots"] * 100) if agg["type_slots"] > 0 else 0.0
    return {
        "symbols": symbols,
        "modules": modules,
        "errors": errors,
        "summary": {
            "totalFiles": len(files),
            "totalFunctions": agg["functions"],
            "totalClasses": agg["classes"],
            "totalTypeSlots": agg["type_slots"],
            "typedSlots": agg["typed_slots"],
            "typeCoveragePct": round(coverage, 1),
            "jediEnabled": jedi_enabled,
            "jediResolved": jedi_upgraded,
            "callResolution": call_summary,
        },
    }


def _jedi_available() -> bool:
    try:
        import jedi  # noqa: F401
        return True
    except Exception:
        return False


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        emit({"error": "empty request"})
        return
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        emit({"error": f"bad json: {e}"})
        return
    cmd = req.get("command")
    if cmd == "index":
        files = req.get("files") or []
        root = req.get("root") or os.getcwd()
        use_jedi = bool(req.get("useJedi", True))
        emit(index_files(files, root, use_jedi=use_jedi))
    else:
        emit({"error": f"unknown command: {cmd}"})


def emit(data: Any) -> None:
    sys.stdout.write(json.dumps(data))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
