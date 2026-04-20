# CodeMap IDL Support — Call Graph & Flowchart Implementation Plan

## Goal

Add IDL (Interactive Data Language) support to CodeMap, producing the same two views that already work for Python:

1. **Call graph** (Level 1): which PRO/FUNCTION calls which. Same renderer as Python call graph.
2. **Flowchart** (Level 1 drill-down): control flow within a single PRO/FUNCTION. Same renderer as Python flowchart.

Both produce standard `GraphDocument` output. No schema changes. No webview changes. Only new adapter scripts and host routing.

---

## IDL Language Summary (what the parser must handle)

### Program structure

IDL files (`.pro`) contain one or more routines. Each routine is either:

```idl
PRO routine_name, param1, param2, KEYWORD1=keyword1, /FLAG1
    ; body
END

FUNCTION function_name, param1, param2, KEYWORD1=keyword1
    ; body
    RETURN, result
END
```

Key facts:
- All routines are top-level. IDL does not have nested functions.
- A `.pro` file can contain multiple PRO/FUNCTION definitions.
- The last routine in a file is typically the "main" routine matching the filename.
- Parameters are positional. Keywords use `KEYWORD=variable` or `/FLAG` syntax.
- IDL is case-insensitive. `PRO`, `Pro`, `pro` are all valid.
- Line continuation uses `$` at end of line.
- Comments start with `;`.
- Strings use single quotes `'string'` or double quotes `"string"`.

### Control flow constructs

```idl
; Conditional
IF condition THEN BEGIN
    ; body
ENDIF ELSE BEGIN
    ; body
ENDELSE

; Short-form if (single statement, no BEGIN/END)
IF condition THEN statement
IF condition THEN statement ELSE other_statement

; For loop
FOR i = 0, N-1 DO BEGIN
    ; body
ENDFOR

; Foreach (IDL 8.0+)
FOREACH element, collection DO BEGIN
    ; body
ENDFOREACH

; While loop
WHILE condition DO BEGIN
    ; body
ENDWHILE

; Repeat-until
REPEAT BEGIN
    ; body
ENDREP UNTIL condition

; Case
CASE expression OF
    value1: BEGIN
        ; body
    END
    value2: statement
    ELSE: statement
ENDCASE

; Switch (IDL 8.4+)
SWITCH expression OF
    value1: BEGIN
        ; body
    END
    ELSE: statement
ENDSWITCH
```

### Call syntax

```idl
; Procedure call (no return value)
procedure_name, arg1, arg2, KEYWORD=value, /FLAG

; Function call (has return value, uses parentheses)
result = function_name(arg1, arg2, KEYWORD=value)

; Method call on object (IDL 8.0+)
object->method_name, arg1, arg2
result = object->method_name(arg1, arg2)
object.method_name, arg1           ; dot syntax (IDL 8.0+)
result = object.method_name(arg1)

; System procedure call
PRINT, value1, value2
PLOT, x, y, TITLE='My Plot'
```

### What makes IDL parsing simpler than Python

- No nested functions or closures
- No decorators
- No comprehensions
- No generators or yield
- No async/await
- No context managers (with/as)
- No multiple inheritance complexity
- No walrus operator
- Scope is flat: everything in a routine is local unless COMMON block
- Keywords are verbose and distinct (ENDFOR, ENDIF, ENDWHILE — not just indentation)

### What makes IDL parsing trickier

- Case insensitivity (must normalize)
- `$` line continuation (must merge before parsing)
- Short-form IF (single-line, no BEGIN/END)
- Procedure calls have no parentheses (just commas): `pro_name, arg1, arg2`
- Ambiguity between array indexing and function calls: `result = name(args)` could be either
- COMMON blocks for shared state across routines
- Optional object-oriented syntax with `->` and `.` method calls

---

## Architecture

```
New files:
  python/idl_analyzer.py    → PyAnalysisResult-compatible output → call graph
  python/idl_flowchart.py   → GraphDocument (flowchart) → flowchart view

Modified files:
  src/python/analysis/pythonRunner.ts  → add runIdlAnalyzer(), buildIdlFlowchartFor()
  src/extension.ts                     → add IDL file detection and routing
  src/providers/fileTreeProvider.ts     → include .pro files in tree
  package.json                         → add IDL to activation events and menus

NOT modified:
  src/python/model/graphTypes.ts       → same schema
  src/python/model/symbolTypes.ts      → same symbol types (subset)
  webview/views/callgraph/*            → same renderer
  webview/views/flowchart/*            → same renderer
  webview/main.js                      → already dispatches by graphType
```

---

## Step 1: Create `python/idl_parser.py` — Shared IDL Parser

This module provides the low-level parsing utilities used by both the analyzer and the flowchart builder. It is not called directly — it is imported by `idl_analyzer.py` and `idl_flowchart.py`.

### 1.1 Line preprocessor

```python
"""
idl_parser.py — Low-level IDL source parser.

Handles:
- Case normalization
- Line continuation merging
- Comment stripping
- Routine boundary detection
- Call site extraction
- Control flow structure detection
"""

import re
from typing import List, Dict, Tuple, Optional, NamedTuple


class SourceLine:
    """A preprocessed source line with original line number preserved."""
    def __init__(self, text: str, line_number: int, raw_text: str):
        self.text = text              # normalized, stripped, continuation-merged
        self.line_number = line_number # original first line number
        self.raw_text = raw_text      # original text (for display)
        self.is_comment = False
        self.is_blank = False


def preprocess_source(source: str) -> List[SourceLine]:
    """
    Preprocess IDL source:
    1. Merge $-continuation lines
    2. Strip comments (but preserve comment-only lines for display)
    3. Normalize case to uppercase for pattern matching
    4. Track original line numbers
    """
    raw_lines = source.splitlines()
    result = []
    i = 0
    
    while i < len(raw_lines):
        raw = raw_lines[i]
        line_num = i + 1  # 1-indexed
        
        # Handle blank lines
        stripped = raw.strip()
        if not stripped:
            sl = SourceLine("", line_num, raw)
            sl.is_blank = True
            result.append(sl)
            i += 1
            continue
        
        # Handle comment-only lines
        if stripped.startswith(';'):
            sl = SourceLine(stripped, line_num, raw)
            sl.is_comment = True
            result.append(sl)
            i += 1
            continue
        
        # Strip inline comments (but not inside strings)
        code_part = _strip_inline_comment(stripped)
        
        # Handle $ line continuation
        merged = code_part
        raw_merged = raw
        while merged.rstrip().endswith('$') and i + 1 < len(raw_lines):
            merged = merged.rstrip()[:-1].rstrip()  # remove trailing $
            i += 1
            next_line = raw_lines[i].strip()
            next_code = _strip_inline_comment(next_line)
            merged = merged + ' ' + next_code
            raw_merged = raw_merged + '\n' + raw_lines[i]
        
        sl = SourceLine(merged.strip(), line_num, raw_merged)
        result.append(sl)
        i += 1
    
    return result


def _strip_inline_comment(line: str) -> str:
    """Remove inline comment from a line, respecting string literals."""
    in_single = False
    in_double = False
    for i, ch in enumerate(line):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == ';' and not in_single and not in_double:
            return line[:i].rstrip()
    return line
```

### 1.2 Routine finder

```python
class RoutineInfo:
    """Parsed information about a PRO or FUNCTION."""
    def __init__(self):
        self.name = ""
        self.kind = ""          # "pro" or "function"
        self.params = []        # positional parameter names
        self.keywords = []      # keyword parameter names
        self.start_line = 0
        self.end_line = 0
        self.body_lines = []    # SourceLine objects for the body
        self.calls = []         # CallSite objects found in body


class CallSite:
    """A detected call to another routine."""
    def __init__(self):
        self.name = ""          # called routine name (uppercase normalized)
        self.line = 0           # source line number
        self.text = ""          # raw call text
        self.call_type = ""     # "function" | "procedure" | "method"
        self.resolution = "unresolved"
        self.resolved_to = None


# Pattern for PRO/FUNCTION declaration
_ROUTINE_PATTERN = re.compile(
    r'^(PRO|FUNCTION)\s+(\w+)\s*(,\s*(.*))?$',
    re.IGNORECASE
)

# Pattern for END
_END_PATTERN = re.compile(r'^END\s*$', re.IGNORECASE)


def find_routines(lines: List[SourceLine]) -> List[RoutineInfo]:
    """Find all PRO/FUNCTION definitions in preprocessed source."""
    routines = []
    current = None
    
    for sl in lines:
        if sl.is_comment or sl.is_blank:
            if current:
                current.body_lines.append(sl)
            continue
        
        upper = sl.text.upper().strip()
        
        # Check for routine start
        m = _ROUTINE_PATTERN.match(sl.text)
        if m:
            if current:
                # Close previous routine (missing END)
                current.end_line = sl.line_number - 1
                routines.append(current)
            
            current = RoutineInfo()
            current.kind = m.group(1).upper().strip()
            current.kind = "function" if current.kind == "FUNCTION" else "pro"
            current.name = m.group(2).strip()
            current.start_line = sl.line_number
            
            # Parse parameters
            if m.group(4):
                current.params, current.keywords = _parse_params(m.group(4))
            
            continue
        
        # Check for END
        if _END_PATTERN.match(upper) or upper.startswith('END;'):
            if current:
                current.end_line = sl.line_number
                routines.append(current)
                current = None
            continue
        
        # Check for scope-closing keywords that also close routines
        # (ENDFOR, ENDIF, etc. do NOT close routines — only bare END does)
        
        # Body line
        if current:
            current.body_lines.append(sl)
    
    # Handle unclosed routine at end of file
    if current:
        current.end_line = lines[-1].line_number if lines else current.start_line
        routines.append(current)
    
    return routines


def _parse_params(param_str: str) -> Tuple[List[str], List[str]]:
    """Parse parameter list into positional params and keyword params."""
    positional = []
    keywords = []
    
    parts = [p.strip() for p in param_str.split(',')]
    for part in parts:
        if not part:
            continue
        
        upper = part.upper()
        
        # /FLAG syntax → boolean keyword
        if part.startswith('/'):
            keywords.append(part[1:].strip().upper())
            continue
        
        # KEYWORD=variable syntax
        if '=' in part:
            kw_name = part.split('=')[0].strip().upper()
            keywords.append(kw_name)
            continue
        
        # Positional parameter
        positional.append(part.strip())
    
    return positional, keywords
```

### 1.3 Call site extractor

```python
# Common IDL built-in procedures (skip these in call graph)
IDL_BUILTINS = {
    'PRINT', 'PRINTF', 'HELP', 'STOP', 'MESSAGE', 'ON_ERROR',
    'OPENR', 'OPENW', 'OPENU', 'CLOSE', 'FREE_LUN',
    'READF', 'READU', 'WRITEU', 'POINT_LUN',
    'PLOT', 'OPLOT', 'CONTOUR', 'SURFACE', 'SHADE_SURF',
    'TVSCL', 'TV', 'LOADCT', 'DEVICE', 'SET_PLOT', 'WINDOW',
    'WIDGET_CONTROL', 'WIDGET_BASE', 'WIDGET_BUTTON', 'WIDGET_TEXT',
    'CD', 'FILE_MKDIR', 'FILE_DELETE', 'SPAWN',
    'PTR_NEW', 'PTR_FREE', 'OBJ_NEW', 'OBJ_DESTROY',
    'CATCH', 'ON_IOERROR', 'RETALL', 'RETURN',
}

# Common IDL built-in functions
IDL_BUILTIN_FUNCTIONS = {
    'WHERE', 'N_ELEMENTS', 'SIZE', 'STRLEN', 'STRMID', 'STRTRIM',
    'STRPOS', 'STRCOMPRESS', 'STRING', 'STRSPLIT', 'STRUPCASE', 'STRLOWCASE',
    'FIX', 'FLOAT', 'DOUBLE', 'LONG', 'BYTE', 'COMPLEX', 'UINT', 'ULONG',
    'FINDGEN', 'INDGEN', 'LINDGEN', 'DINDGEN', 'FLTARR', 'DBLARR',
    'INTARR', 'LONARR', 'BYTARR', 'STRARR', 'COMPLEXARR', 'OBJARR',
    'MAKE_ARRAY', 'REPLICATE', 'REFORM', 'REBIN', 'CONGRID',
    'TOTAL', 'MEAN', 'MEDIAN', 'MIN', 'MAX', 'SORT', 'UNIQ', 'REVERSE',
    'SHIFT', 'ROTATE', 'TRANSPOSE', 'DIAG_MATRIX',
    'ABS', 'SQRT', 'ALOG', 'ALOG10', 'EXP', 'SIN', 'COS', 'TAN',
    'ASIN', 'ACOS', 'ATAN', 'CEIL', 'FLOOR', 'ROUND',
    'FFT', 'CONVOL', 'SMOOTH', 'INTERPOLATE', 'INTERPOL',
    'POLY_FIT', 'CURVEFIT', 'GAUSSFIT', 'REGRESS',
    'FILE_SEARCH', 'FILE_TEST', 'FILE_INFO', 'FILE_LINES',
    'DIALOG_PICKFILE', 'DIALOG_MESSAGE',
    'SYSTIME', 'KEYWORD_SET', 'N_PARAMS', 'ARG_PRESENT',
    'TAG_NAMES', 'CREATE_STRUCT', 'N_TAGS',
    'PTR_VALID', 'OBJ_VALID', 'OBJ_ISA', 'OBJ_CLASS',
    'EXECUTE', 'CALL_FUNCTION', 'CALL_PROCEDURE',
    'FINITE', 'ISHFT', 'BYTSCL',
    'READ_ASCII', 'READ_BINARY', 'READ_CSV',
    'MRDFITS', 'READFITS', 'SXPAR', 'FXPAR',  # common astro library
}

# Patterns for detecting calls
_FUNCTION_CALL = re.compile(
    r'(\w+)\s*\(',   # name followed by (
    re.IGNORECASE
)

_PROCEDURE_CALL = re.compile(
    r'^(\w+)\s*,',   # name at start of line followed by comma
    re.IGNORECASE
)

_METHOD_CALL_ARROW = re.compile(
    r'(\w+)\s*->\s*(\w+)',  # object->method
    re.IGNORECASE
)

_METHOD_CALL_DOT = re.compile(
    r'(\w+)\s*\.\s*(\w+)\s*[,(]',  # object.method, or object.method(
    re.IGNORECASE
)


def extract_calls(body_lines: List[SourceLine]) -> List[CallSite]:
    """Extract all call sites from routine body lines."""
    calls = []
    
    for sl in body_lines:
        if sl.is_comment or sl.is_blank:
            continue
        
        text = sl.text
        upper = text.upper().strip()
        
        # Skip control flow keywords
        if any(upper.startswith(kw) for kw in [
            'IF ', 'ENDIF', 'ELSE', 'FOR ', 'ENDFOR', 'FOREACH ',
            'ENDFOREACH', 'WHILE ', 'ENDWHILE', 'REPEAT', 'ENDREP',
            'CASE ', 'ENDCASE', 'SWITCH ', 'ENDSWITCH',
            'BEGIN', 'END', 'RETURN', 'BREAK', 'CONTINUE',
            'GOTO', 'COMMON', 'FORWARD_FUNCTION',
            'COMPILE_OPT', 'ON_ERROR',
        ]):
            # But some of these may contain calls in their expressions
            # Extract function calls from expressions within these lines
            _extract_function_calls_from_expr(text, sl.line_number, calls)
            continue
        
        # Check for procedure call pattern: NAME, arg1, arg2
        pm = _PROCEDURE_CALL.match(text.strip())
        if pm:
            name = pm.group(1).upper()
            if name not in IDL_BUILTINS and not name.startswith('!'):
                cs = CallSite()
                cs.name = name
                cs.line = sl.line_number
                cs.text = text.strip()
                cs.call_type = "procedure"
                calls.append(cs)
        
        # Check for method calls: object->method or object.method
        for mm in _METHOD_CALL_ARROW.finditer(text):
            cs = CallSite()
            cs.name = mm.group(2).upper()
            cs.line = sl.line_number
            cs.text = mm.group(0)
            cs.call_type = "method"
            calls.append(cs)
        
        for mm in _METHOD_CALL_DOT.finditer(text):
            name = mm.group(2).upper()
            # Avoid matching struct.field access (heuristic: methods are followed by , or ()
            cs = CallSite()
            cs.name = name
            cs.line = sl.line_number
            cs.text = mm.group(0)
            cs.call_type = "method"
            calls.append(cs)
        
        # Extract function calls from the line
        _extract_function_calls_from_expr(text, sl.line_number, calls)
    
    return calls


def _extract_function_calls_from_expr(text: str, line_number: int, calls: List[CallSite]):
    """Extract function calls (name followed by parentheses) from an expression."""
    for fm in _FUNCTION_CALL.finditer(text):
        name = fm.group(1).upper()
        
        # Skip control flow keywords that use parentheses
        if name in ('IF', 'WHILE', 'CASE', 'SWITCH', 'FOR', 'FOREACH', 'REPEAT'):
            continue
        
        # Skip built-in functions
        if name in IDL_BUILTIN_FUNCTIONS:
            continue
        
        # Skip array indexing heuristic: if name was previously seen as a variable
        # assignment (e.g., arr = FLTARR(100)), then arr(i) is indexing, not a call.
        # This is a known ambiguity in IDL. We include it as a call with low confidence.
        
        # Check if already added (e.g., as a procedure call on same line)
        if any(c.name == name and c.line == line_number for c in calls):
            continue
        
        cs = CallSite()
        cs.name = name
        cs.line = line_number
        cs.text = fm.group(0)
        cs.call_type = "function"
        calls.append(cs)
```

### 1.4 Control flow structure detector (for flowchart)

```python
class ControlFlowBlock:
    """A detected control flow structure."""
    def __init__(self, kind, line, text, end_line=None):
        self.kind = kind          # "if", "for", "while", "repeat", "case", "switch"
        self.line = line          # start line
        self.text = text          # header text
        self.end_line = end_line  # closing keyword line
        self.children = []        # nested blocks
        self.else_blocks = []     # else/elif blocks for if


# Patterns for control flow
_IF_PATTERN = re.compile(r'^IF\b', re.IGNORECASE)
_FOR_PATTERN = re.compile(r'^FOR\s+(\w+)\s*=', re.IGNORECASE)
_FOREACH_PATTERN = re.compile(r'^FOREACH\s+(\w+)\s*,', re.IGNORECASE)
_WHILE_PATTERN = re.compile(r'^WHILE\b', re.IGNORECASE)
_REPEAT_PATTERN = re.compile(r'^REPEAT\b', re.IGNORECASE)
_CASE_PATTERN = re.compile(r'^CASE\b', re.IGNORECASE)
_SWITCH_PATTERN = re.compile(r'^SWITCH\b', re.IGNORECASE)

_ENDIF = re.compile(r'^ENDIF\b', re.IGNORECASE)
_ENDELSE = re.compile(r'^ENDELSE\b', re.IGNORECASE)
_ELSE = re.compile(r'^ELSE\b', re.IGNORECASE)
_ENDFOR = re.compile(r'^ENDFOR\b', re.IGNORECASE)
_ENDFOREACH = re.compile(r'^ENDFOREACH\b', re.IGNORECASE)
_ENDWHILE = re.compile(r'^ENDWHILE\b', re.IGNORECASE)
_ENDREP = re.compile(r'^ENDREP\b', re.IGNORECASE)
_ENDCASE = re.compile(r'^ENDCASE\b', re.IGNORECASE)
_ENDSWITCH = re.compile(r'^ENDSWITCH\b', re.IGNORECASE)

# Detect if a line has BEGIN (multi-line block) vs single-statement
_HAS_BEGIN = re.compile(r'\bBEGIN\b', re.IGNORECASE)
_HAS_THEN = re.compile(r'\bTHEN\b', re.IGNORECASE)
_HAS_DO = re.compile(r'\bDO\b', re.IGNORECASE)


def detect_control_flow(body_lines: List[SourceLine]) -> List[dict]:
    """
    Detect control flow structures in routine body.
    Returns a flat list of flowchart-ready nodes with kinds:
    - process, decision, loop, return, etc.
    
    This produces the same node structure as Python's flowchart.py output.
    """
    nodes = []
    node_id = 0
    
    for sl in body_lines:
        if sl.is_blank:
            continue
        
        upper = sl.text.upper().strip()
        
        if sl.is_comment:
            continue  # skip comments in flowchart
        
        node_id += 1
        nid = f"n{node_id}"
        
        # ── Control flow openers ──
        if _IF_PATTERN.match(upper):
            nodes.append({
                "id": nid,
                "kind": "decision",
                "label": sl.text.strip(),
                "line": sl.line_number,
                "structure": "if",
                "has_block": bool(_HAS_BEGIN.search(upper)),
            })
            continue
        
        if _FOR_PATTERN.match(upper) or _FOREACH_PATTERN.match(upper):
            nodes.append({
                "id": nid,
                "kind": "loop",
                "label": sl.text.strip(),
                "line": sl.line_number,
                "structure": "for",
                "has_block": bool(_HAS_BEGIN.search(upper)),
            })
            continue
        
        if _WHILE_PATTERN.match(upper):
            nodes.append({
                "id": nid,
                "kind": "loop",
                "label": sl.text.strip(),
                "line": sl.line_number,
                "structure": "while",
                "has_block": bool(_HAS_BEGIN.search(upper)),
            })
            continue
        
        if _REPEAT_PATTERN.match(upper):
            nodes.append({
                "id": nid,
                "kind": "loop",
                "label": sl.text.strip(),
                "line": sl.line_number,
                "structure": "repeat",
                "has_block": True,
            })
            continue
        
        if _CASE_PATTERN.match(upper) or _SWITCH_PATTERN.match(upper):
            nodes.append({
                "id": nid,
                "kind": "decision",
                "label": sl.text.strip(),
                "line": sl.line_number,
                "structure": "case",
            })
            continue
        
        # ── Control flow closers (generate merge/loop-back nodes) ──
        if any(p.match(upper) for p in [_ENDIF, _ENDELSE]):
            nodes.append({"id": nid, "kind": "process", "label": upper.split(';')[0].strip(), "line": sl.line_number, "structure": "end_if"})
            continue
        
        if any(p.match(upper) for p in [_ENDFOR, _ENDFOREACH]):
            nodes.append({"id": nid, "kind": "process", "label": upper.split(';')[0].strip(), "line": sl.line_number, "structure": "end_loop"})
            continue
        
        if _ENDWHILE.match(upper):
            nodes.append({"id": nid, "kind": "process", "label": upper.split(';')[0].strip(), "line": sl.line_number, "structure": "end_loop"})
            continue
        
        if _ENDREP.match(upper):
            nodes.append({"id": nid, "kind": "process", "label": upper.split(';')[0].strip(), "line": sl.line_number, "structure": "end_repeat"})
            continue
        
        if any(p.match(upper) for p in [_ENDCASE, _ENDSWITCH]):
            nodes.append({"id": nid, "kind": "process", "label": upper.split(';')[0].strip(), "line": sl.line_number, "structure": "end_case"})
            continue
        
        if _ELSE.match(upper):
            nodes.append({"id": nid, "kind": "decision", "label": "ELSE", "line": sl.line_number, "structure": "else"})
            continue
        
        # ── Regular statements ──
        if upper.startswith('RETURN'):
            nodes.append({"id": nid, "kind": "return", "label": sl.text.strip(), "line": sl.line_number})
            continue
        
        if upper.startswith('BREAK'):
            nodes.append({"id": nid, "kind": "break", "label": "BREAK", "line": sl.line_number})
            continue
        
        if upper.startswith('CONTINUE'):
            nodes.append({"id": nid, "kind": "continue", "label": "CONTINUE", "line": sl.line_number})
            continue
        
        # Default: process node
        # Classify as compute if it has assignment
        kind = "process"
        if '=' in sl.text and not any(op in sl.text for op in ['EQ', 'NE', 'GE', 'LE', 'GT', 'LT']):
            # Has assignment (but not comparison operators)
            kind = "compute"
        
        nodes.append({
            "id": nid,
            "kind": kind,
            "label": sl.text.strip(),
            "line": sl.line_number,
        })
    
    return nodes
```

---

## Step 2: Create `python/idl_analyzer.py` — Call Graph Adapter

This produces the same output shape as `python/analyzer.py` — a `PyAnalysisResult`-compatible JSON with symbols, modules, and call resolution.

```python
"""
idl_analyzer.py — IDL workspace analyzer for CodeMap.

Input (stdin JSON):
{
    "command": "index",
    "files": ["path/to/file1.pro", "path/to/file2.pro"],
    "root": "workspace/root"
}

Output (stdout JSON): PyAnalysisResult-compatible
{
    "symbols": { ... },
    "modules": { ... },
    "errors": [ ... ],
    "summary": { ... }
}
"""

import sys
import json
import os
from idl_parser import preprocess_source, find_routines, extract_calls, IDL_BUILTINS, IDL_BUILTIN_FUNCTIONS


def main():
    request = json.loads(sys.stdin.read())
    command = request.get("command", "index")
    files = request.get("files", [])
    root = request.get("root", "")
    
    if command != "index":
        print(json.dumps({"error": f"Unknown command: {command}"}))
        return
    
    all_symbols = {}
    all_modules = {}
    errors = []
    all_routines = {}  # name -> symbol id, for call resolution
    
    total_functions = 0
    total_files = len(files)
    
    for file_path in files:
        try:
            with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
                source = f.read()
        except Exception as e:
            errors.append({"file": file_path, "message": str(e)})
            continue
        
        # Determine module name from file path
        rel_path = os.path.relpath(file_path, root) if root else file_path
        module_name = rel_path.replace(os.sep, '.').replace('.pro', '')
        
        # Parse
        lines = preprocess_source(source)
        routines = find_routines(lines)
        
        # Register module
        module_id = f"{module_name}:<module>"
        all_modules[module_name] = module_id
        
        for routine in routines:
            total_functions += 1
            
            # Build symbol ID
            sym_id = f"{module_name}:{routine.name}"
            
            # Extract calls
            routine.calls = extract_calls(routine.body_lines)
            
            # Build symbol entry (PyAnalysisResult-compatible)
            symbol = {
                "id": sym_id,
                "kind": "function" if routine.kind == "function" else "function",  # IDL PRO maps to function kind
                "name": routine.name,
                "qualifiedName": f"{module_name}.{routine.name}",
                "module": module_name,
                "file": file_path,
                "source": {
                    "file": file_path,
                    "line": routine.start_line,
                    "column": 0,
                    "endLine": routine.end_line,
                    "endColumn": 0
                },
                "params": [
                    {"name": p, "type": None, "typeSource": None}
                    for p in routine.params
                ],
                "calls": [],
                "decorators": [],
                "isAsync": False,
            }
            
            # Convert call sites
            for cs in routine.calls:
                call_entry = {
                    "text": cs.text,
                    "line": cs.line,
                    "column": 0,
                    "resolution": cs.resolution,
                }
                
                # Check if call target exists in our known routines
                # (will be resolved after all files are processed)
                call_entry["_targetName"] = cs.name
                symbol["calls"].append(call_entry)
            
            all_symbols[sym_id] = symbol
            all_routines[routine.name.upper()] = sym_id
    
    # ── Call resolution pass ──
    resolved_count = 0
    unresolved_count = 0
    builtin_count = 0
    
    for sym_id, symbol in all_symbols.items():
        for call in symbol["calls"]:
            target_name = call.pop("_targetName", "").upper()
            
            if target_name in all_routines:
                call["resolvedTo"] = all_routines[target_name]
                call["resolution"] = "resolved"
                resolved_count += 1
            elif target_name in IDL_BUILTINS or target_name in IDL_BUILTIN_FUNCTIONS:
                call["resolution"] = "unresolved"
                call["resolutionSource"] = "builtin"
                builtin_count += 1
            else:
                call["resolution"] = "unresolved"
                unresolved_count += 1
    
    # ── Build output ──
    result = {
        "symbols": all_symbols,
        "modules": all_modules,
        "errors": errors,
        "summary": {
            "totalFiles": total_files,
            "totalFunctions": total_functions,
            "totalClasses": 0,
            "totalTypeSlots": 0,
            "typedSlots": 0,
            "typeCoveragePct": 0.0,
            "jediEnabled": False,
            "jediResolved": 0,
            "callResolution": {
                "total": resolved_count + unresolved_count + builtin_count,
                "resolved": resolved_count,
                "likely": 0,
                "unresolved": unresolved_count,
                "builtin": builtin_count,
                "outOfScope": 0,
                "jedi": 0
            }
        }
    }
    
    print(json.dumps(result))


if __name__ == "__main__":
    main()
```

---

## Step 3: Create `python/idl_flowchart.py` — Flowchart Adapter

```python
"""
idl_flowchart.py — IDL flowchart builder for CodeMap.

Input (stdin JSON):
{
    "file": "path/to/file.pro",
    "line": 42
}

Output (stdout JSON): GraphDocument with graphType "flowchart"
"""

import sys
import json
from idl_parser import preprocess_source, find_routines, detect_control_flow


def main():
    request = json.loads(sys.stdin.read())
    file_path = request["file"]
    target_line = request["line"]
    
    with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
        source = f.read()
    
    lines = preprocess_source(source)
    routines = find_routines(lines)
    
    # Find the routine containing target_line
    target_routine = None
    for routine in routines:
        if routine.start_line <= target_line <= routine.end_line:
            target_routine = routine
            break
    
    if target_routine is None:
        # Fallback: use the first routine, or the last one (common convention)
        if routines:
            target_routine = routines[-1]
        else:
            print(json.dumps({"error": "No routine found"}))
            return
    
    # Detect control flow
    cf_nodes = detect_control_flow(target_routine.body_lines)
    
    # Build entry node
    kind_label = "FUNCTION" if target_routine.kind == "function" else "PRO"
    entry_label = f"{kind_label} {target_routine.name}"
    if target_routine.params:
        entry_label += f"({', '.join(target_routine.params)})"
    
    graph_nodes = [
        {
            "id": "entry",
            "kind": "entry",
            "label": entry_label,
            "source": {
                "file": file_path,
                "line": target_routine.start_line,
                "endLine": target_routine.start_line
            }
        }
    ]
    
    graph_edges = []
    
    # Convert control flow nodes to GraphNodes
    prev_id = "entry"
    group_stack = []  # for building group metadata
    groups = []
    
    for cf in cf_nodes:
        node = {
            "id": cf["id"],
            "kind": cf["kind"],
            "label": cf["label"],
            "source": {
                "file": file_path,
                "line": cf["line"],
                "endLine": cf["line"]
            }
        }
        graph_nodes.append(node)
        
        # Build control flow edges
        structure = cf.get("structure", "")
        
        if structure == "if":
            # Decision node: yes/no edges will be connected to children
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow"
            })
            group_stack.append({"start_id": cf["id"], "kind": "if", "line": cf["line"]})
            prev_id = cf["id"]
            
        elif structure == "else":
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow",
                "label": "no"
            })
            prev_id = cf["id"]
            
        elif structure in ("for", "while"):
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow"
            })
            group_stack.append({"start_id": cf["id"], "kind": "loop", "line": cf["line"]})
            prev_id = cf["id"]
            
        elif structure == "repeat":
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow"
            })
            group_stack.append({"start_id": cf["id"], "kind": "repeat", "line": cf["line"]})
            prev_id = cf["id"]
        
        elif structure in ("end_if",):
            # Merge point after if/else
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow"
            })
            if group_stack:
                g = group_stack.pop()
                groups.append({
                    "id": f"group-{g['kind']}-L{g['line']}",
                    "label": g["kind"],
                    "startNodeId": g["start_id"],
                    "endNodeId": cf["id"]
                })
            prev_id = cf["id"]
        
        elif structure in ("end_loop",):
            # Loop back edge
            if group_stack and group_stack[-1]["kind"] in ("loop", "for", "while"):
                loop_start = group_stack[-1]["start_id"]
                graph_edges.append({
                    "id": f"e-{prev_id}-{loop_start}-repeat",
                    "from": prev_id,
                    "to": loop_start,
                    "kind": "control_flow",
                    "label": "repeat"
                })
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow",
                "label": "done"
            })
            if group_stack:
                g = group_stack.pop()
                groups.append({
                    "id": f"group-{g['kind']}-L{g['line']}",
                    "label": g["kind"],
                    "startNodeId": g["start_id"],
                    "endNodeId": cf["id"]
                })
            prev_id = cf["id"]
            
        elif structure == "end_repeat":
            # Repeat loops back to condition at ENDREP UNTIL
            if group_stack and group_stack[-1]["kind"] == "repeat":
                loop_start = group_stack[-1]["start_id"]
                graph_edges.append({
                    "id": f"e-{prev_id}-{loop_start}-repeat",
                    "from": prev_id,
                    "to": loop_start,
                    "kind": "control_flow",
                    "label": "repeat"
                })
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow",
                "label": "until"
            })
            if group_stack:
                g = group_stack.pop()
                groups.append({
                    "id": f"group-{g['kind']}-L{g['line']}",
                    "label": g["kind"],
                    "startNodeId": g["start_id"],
                    "endNodeId": cf["id"]
                })
            prev_id = cf["id"]
        
        elif structure == "case" or structure == "end_case":
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow"
            })
            prev_id = cf["id"]
        
        else:
            # Regular statement
            graph_edges.append({
                "id": f"e-{prev_id}-{cf['id']}",
                "from": prev_id,
                "to": cf["id"],
                "kind": "control_flow"
            })
            prev_id = cf["id"]
    
    # Build output GraphDocument
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
            "groups": groups
        }
    }
    
    print(json.dumps(graph))


if __name__ == "__main__":
    main()
```

---

## Step 4: Wire the Host

### 4.1 Add IDL runner functions

File: `src/python/analysis/pythonRunner.ts`

Add alongside existing Python runner functions:

```typescript
export async function indexIdlWorkspace(
    files: string[],
    root: string
): Promise<PyAnalysisResult> {
    const request = { command: 'index', files, root };
    return await runPythonScript('idl_analyzer.py', request) as PyAnalysisResult;
}

export async function buildIdlFlowchartFor(
    file: string,
    line: number
): Promise<GraphDocument> {
    const request = { file, line };
    return await runPythonScript('idl_flowchart.py', request) as GraphDocument;
}
```

### 4.2 Update file tree provider

File: `src/providers/fileTreeProvider.ts`

Add `.pro` to the included file extensions:

```typescript
// Find the file filter pattern and add .pro
// Current: **/*.py
// New: **/*.{py,pro}
```

### 4.3 Add IDL commands

File: `src/extension.ts`

Add IDL-specific command handlers or extend existing ones to detect file type:

```typescript
// In the showFlowchart command handler, detect file extension:
const ext = path.extname(file).toLowerCase();
let graph: GraphDocument;
if (ext === '.pro') {
    graph = await buildIdlFlowchartFor(file, line);
} else {
    graph = await buildFlowchartFor(file, line);
}

// In the showWorkspaceGraph command handler:
// Detect if workspace contains .pro files and include them in analysis
const pyFiles = await vscode.workspace.findFiles('**/*.py', ...excludes);
const idlFiles = await vscode.workspace.findFiles('**/*.pro', ...excludes);

if (idlFiles.length > 0) {
    const idlAnalysis = await indexIdlWorkspace(
        idlFiles.map(f => f.fsPath),
        workspaceRoot
    );
    // Merge IDL symbols into workspace graph
    // (or keep separate and merge at GraphDocument level)
}
```

### 4.4 Update package.json

```json
{
    "activationEvents": [
        "onLanguage:python",
        "onLanguage:idl"
    ],
    "contributes": {
        "commands": [
            {
                "command": "codemap.showFlowchart",
                "title": "CodeMap: Show Flowchart"
            }
        ],
        "menus": {
            "editor/context": [
                {
                    "command": "codemap.showFlowchart",
                    "when": "editorLangId == python || editorLangId == idl",
                    "group": "codemap"
                }
            ]
        }
    }
}
```

Note: IDL language support in VS Code requires the user to install an IDL language extension (e.g., "IDL for VSCode" by ENVI). This provides the `idl` language ID. If no IDL extension is installed, you can alternatively match on file extension `.pro` using a `when` clause like `resourceExtname == .pro`.

---

## Step 5: Test

### Test files

Create `test_samples/sample_idl.pro`:

```idl
;+
; Sample IDL routine for testing CodeMap
;-
PRO sample_process, data, threshold, VERBOSE=verbose, /NORMALIZE

    COMPILE_OPT IDL2
    
    ; Initialize
    n = N_ELEMENTS(data)
    result = FLTARR(n)
    
    ; Process each element
    FOR i = 0, n-1 DO BEGIN
        IF data[i] GT threshold THEN BEGIN
            result[i] = data[i] - threshold
            IF KEYWORD_SET(normalize) THEN BEGIN
                result[i] = result[i] / MAX(data)
            ENDIF
        ENDIF ELSE BEGIN
            result[i] = 0.0
        ENDELSE
    ENDFOR
    
    ; Apply post-processing
    helper_smooth, result, 3
    
    IF KEYWORD_SET(verbose) THEN BEGIN
        PRINT, 'Processed ', n, ' elements'
        PRINT, 'Max result: ', MAX(result)
    ENDIF
    
    RETURN
END


FUNCTION helper_smooth, data, width
    COMPILE_OPT IDL2
    
    smoothed = SMOOTH(data, width, /EDGE_TRUNCATE)
    RETURN, smoothed
END
```

### Expected results

**Analyzer output should contain:**
- 2 symbols: `sample_process` (kind: function), `helper_smooth` (kind: function)
- `sample_process` should have 1 resolved call to `helper_smooth`
- `sample_process` params: `data`, `threshold`
- `sample_process` keywords: `VERBOSE`, `NORMALIZE`

**Flowchart output for sample_process should contain:**
- Entry node: `PRO sample_process`
- Process nodes for assignments
- Loop node for FOR
- Decision nodes for IF blocks
- Return node
- Control flow edges with loop-back edge from ENDFOR to FOR

---

## File Checklist

| File | Action | Description |
|------|--------|-------------|
| `python/idl_parser.py` | CREATE | Shared IDL parsing utilities |
| `python/idl_analyzer.py` | CREATE | Call graph adapter (Level 1) |
| `python/idl_flowchart.py` | CREATE | Flowchart adapter |
| `src/python/analysis/pythonRunner.ts` | EDIT | Add IDL runner functions |
| `src/extension.ts` | EDIT | Add IDL file detection and routing |
| `src/providers/fileTreeProvider.ts` | EDIT | Include .pro files |
| `package.json` | EDIT | Add IDL activation and menus |
| `test_samples/sample_idl.pro` | CREATE | Test file |

## Files NOT Modified

| File | Reason |
|------|--------|
| `src/python/model/graphTypes.ts` | Same schema works for IDL |
| `webview/views/flowchart/*` | Same renderer, IDL flowchart is just different node labels |
| `webview/views/callgraph/*` | Same renderer, IDL symbols are just different names |
| `webview/main.js` | Already dispatches by graphType |
| `python/analyzer.py` | Python-specific, unchanged |
| `python/flowchart.py` | Python-specific, unchanged |

---

## Known Limitations

1. **Array vs function call ambiguity**: `result = name(args)` could be array indexing or a function call in IDL. The parser defaults to treating it as a function call. A heuristic improvement: track variables that were assigned array values and treat subsequent `name(index)` as indexing.

2. **Object-oriented IDL**: Method calls via `->` and `.` syntax are detected but method resolution (which class defines the method) is not implemented. Methods appear as unresolved calls in the call graph.

3. **COMMON blocks**: Variables shared via COMMON blocks create implicit data flow between routines. This is not represented in the call graph (it would require a separate data-flow analysis across routines).

4. **COMPILE_OPT**: The parser skips COMPILE_OPT lines. In strict IDL2 mode, parentheses always mean function calls (not array indexing). A future enhancement could use this to resolve the array/function ambiguity.

5. **Include files**: `@include_file` directives are not followed. Only the directly provided files are parsed.

6. **System procedures in libraries**: Calls to third-party library routines (e.g., MRDFITS, READFITS from astrolib) appear as unresolved. A future enhancement could include a library signature database.