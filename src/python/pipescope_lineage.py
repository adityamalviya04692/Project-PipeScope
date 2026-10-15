"""PipeScope lineage engine: table- and column-level lineage for SQL pipelines.

Built on sqlglot. The same module runs under CPython (pytest) and under
Pyodide in the browser. Public entry points take and return JSON strings, so
the JavaScript side never has to touch Python objects.

Pipeline:
  1. Split every file into statements (one bad statement does not lose the file).
  2. Classify each statement: DDL, CTAS/view, INSERT, MERGE or a plain query.
  3. Order statements topologically, so files can arrive in any order and a
     model's upstream schema is always known before the model is analysed.
  4. Qualify each query against the schema built so far (expands SELECT *),
     then trace every output column back to physical source columns.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import sqlglot
from sqlglot import exp
from sqlglot.lineage import lineage as sg_lineage
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import build_scope, traverse_scope

DEFAULT_DB = "default"
ENGINE_VERSION = "1.0"
MAX_EXPR = 400
TRACEABLE_COMMANDS = {"CREATE", "INSERT", "MERGE", "SELECT", "WITH", "REPLACE"}

# sqlglot logs a warning for every statement it falls back on; we report those ourselves.
logging.getLogger("sqlglot").setLevel(logging.ERROR)

Json = Dict[str, Any]


# ----------------------------------------------------------------- naming

def table_key(t: exp.Table) -> str:
    """Canonical "db.table" key (catalog dropped, db defaulting to "default")."""
    return f"{(t.db or DEFAULT_DB).lower()}.{t.name.lower()}"


def _ident(name: str) -> str:
    return name.strip('`"[] ').lower()


def _expr_sql(e: Optional[exp.Expression], dialect: str) -> str:
    if e is None:
        return ""
    inner = e.this if isinstance(e, exp.Alias) else e
    if not isinstance(inner, exp.Expression):
        return ""
    s = inner.sql(dialect=dialect)
    return s if len(s) <= MAX_EXPR else s[: MAX_EXPR - 1] + "…"


# ------------------------------------------------------------- statements

class Statement:
    __slots__ = ("file", "index", "kind", "target", "query", "insert_columns", "ddl_columns", "merge", "sql", "upstream", "has_star")

    def __init__(self, file: str, index: int, kind: str, target: Optional[str], sql: str, query: Optional[exp.Expression] = None,
                 insert_columns: Optional[List[str]] = None, ddl_columns: Optional[Dict[str, str]] = None, merge: Optional[exp.Merge] = None):
        self.file = file
        self.index = index
        self.kind = kind
        self.target = target
        self.sql = sql
        self.query = query
        self.insert_columns = insert_columns
        self.ddl_columns = ddl_columns
        self.merge = merge
        self.upstream: Set[str] = set()
        self.has_star = False


def _schema_target(this: Optional[exp.Expression]) -> Tuple[Optional[exp.Table], Optional[List[str]], Optional[Dict[str, str]]]:
    if isinstance(this, exp.Schema):
        table = this.this if isinstance(this.this, exp.Table) else None
        names: List[str] = []
        types: Dict[str, str] = {}
        for e in this.expressions:
            if isinstance(e, exp.ColumnDef):
                n = e.name.lower()
                kind = e.args.get("kind")
                names.append(n)
                types[n] = kind.sql() if kind is not None else "string"
            elif isinstance(e, (exp.Identifier, exp.Column)):
                names.append(e.name.lower())
                types[e.name.lower()] = "string"
        return table, names, types
    if isinstance(this, exp.Table):
        return this, None, None
    return None, None, None


def _has_star(q: exp.Expression) -> bool:
    return any(not isinstance(s.parent, exp.Count) for s in q.find_all(exp.Star))


def classify_statement(stmt: exp.Expression, file: str, index: int, dialect: str) -> Optional[Statement]:
    try:
        sql = stmt.sql(dialect=dialect, pretty=True)
    except Exception:  # pragma: no cover - generation failures are not fatal
        sql = str(stmt)
    if isinstance(stmt, exp.Create):
        kind = str(stmt.args.get("kind") or "").upper()
        if kind not in ("TABLE", "VIEW"):
            return None
        table, names, types = _schema_target(stmt.this)
        if table is None:
            return None
        q = stmt.expression
        if isinstance(q, exp.Query):
            return Statement(file, index, "view" if kind == "VIEW" else "table", table_key(table), sql, query=q, insert_columns=names or None)
        if names:
            return Statement(file, index, "ddl", table_key(table), sql, ddl_columns=types)
        return None
    if isinstance(stmt, exp.Insert):
        table, names, _ = _schema_target(stmt.this)
        q = stmt.expression
        if table is None or not isinstance(q, exp.Query):
            return None
        return Statement(file, index, "insert", table_key(table), sql, query=q, insert_columns=names)
    if isinstance(stmt, exp.Merge):
        if not isinstance(stmt.this, exp.Table):
            return None
        return Statement(file, index, "merge", table_key(stmt.this), sql, merge=stmt)
    if isinstance(stmt, exp.Query):
        stem = re.sub(r"\W+", "_", file.rsplit("/", 1)[-1].rsplit(".", 1)[0]).strip("_").lower() or "query"
        return Statement(file, index, "query", f"adhoc.{stem}_{index + 1}", sql, query=stmt)
    return None


def physical_sources(q: exp.Expression) -> Set[str]:
    """Physical tables a query reads, ignoring CTE and subquery aliases."""
    out: Set[str] = set()
    try:
        for scope in traverse_scope(q):
            for src in scope.sources.values():
                if isinstance(src, exp.Table) and src.name:
                    out.add(table_key(src))
        return out
    except Exception:
        ctes = {c.alias_or_name.lower() for c in q.find_all(exp.CTE)}
        for t in q.find_all(exp.Table):
            if t.name and (t.db or t.name.lower() not in ctes):
                out.add(table_key(t))
        return out


# ------------------------------------------------------------------- Jinja

_COMMENT = re.compile(r"\{#.*?#\}", re.S)
_INCREMENTAL = re.compile(r"\{%-?\s*if\s+is_incremental\(\)\s*-?%\}.*?\{%-?\s*endif\s*-?%\}", re.S)
_CONFIG = re.compile(r"\{\{\s*config\(.*?\)\s*\}\}", re.S)
_REF = re.compile(r"\{\{\s*ref\((.*?)\)\s*\}\}", re.S)
_SOURCE = re.compile(r"\{\{\s*source\((.*?)\)\s*\}\}", re.S)
_EXPR = re.compile(r"\{\{.*?\}\}", re.S)
_TAG = re.compile(r"\{%.*?%\}", re.S)
_ARGS = re.compile(r"['\"]([^'\"]+)['\"]")


def render_jinja(sql: str, refs: Optional[Dict[str, str]] = None, sources: Optional[Dict[Tuple[str, str], str]] = None) -> str:
    """Best-effort removal of dbt Jinja so the SQL parses. Compiled SQL is always preferred."""
    refs = refs or {}
    sources = sources or {}

    def ref(m: "re.Match[str]") -> str:
        args = _ARGS.findall(m.group(1))
        return refs.get(args[-1], args[-1]) if args else "NULL"

    def source(m: "re.Match[str]") -> str:
        args = _ARGS.findall(m.group(1))
        if len(args) >= 2:
            return sources.get((args[0], args[1]), f"{args[0]}.{args[1]}")
        return "NULL"

    out = _COMMENT.sub("", sql)
    out = _INCREMENTAL.sub("", out)
    out = _CONFIG.sub("", out)
    out = _REF.sub(ref, out)
    out = _SOURCE.sub(source, out)
    out = _EXPR.sub("NULL", out)
    return _TAG.sub("", out)


# ------------------------------------------------------------------ engine

class Engine:
    def __init__(self, dialect: str):
        self.d = dialect
        self.schema: Dict[str, Dict[str, Dict[str, str]]] = {}
        self.tables: Dict[str, Json] = {}
        self.problems: List[Json] = []
        self.statements = 0
        self.skipped = 0

    # --- bookkeeping
    def problem(self, severity: str, code: str, message: str, file: Optional[str] = None, table: Optional[str] = None, column: Optional[str] = None) -> None:
        p: Json = {"severity": severity, "code": code, "message": message}
        if file:
            p["file"] = file
        if table:
            p["table"] = table
        if column:
            p["column"] = column
        self.problems.append(p)

    def node(self, key: str, kind: str) -> Json:
        n = self.tables.get(key)
        if n is None:
            n = {"id": key, "kind": kind, "files": [], "statements": [], "columns": {}, "upstream": set(), "indirect": [], "description": None}
            self.tables[key] = n
        elif kind in ("table", "view", "query") and n["kind"] in ("source", "external"):
            n["kind"] = kind  # a model that also has DDL is a model
        return n

    def register(self, key: str, columns: Iterable[Tuple[str, str]]) -> None:
        db, name = key.split(".", 1)
        tbl = self.schema.setdefault(db, {}).setdefault(name, {})
        for c, t in columns:
            tbl.setdefault(c, t or "string")

    def known(self, key: str) -> Optional[List[str]]:
        db, name = key.split(".", 1)
        cols = self.schema.get(db, {}).get(name)
        return list(cols) if cols else None

    @staticmethod
    def add_column(node: Json, col: Json) -> None:
        cur = node["columns"].get(col["name"])
        if cur is None:
            node["columns"][col["name"]] = col
            return
        # Several statements write the same table (e.g. INSERT after CTAS): union the sources.
        seen = {(s["table"], s["column"]) for s in cur["sources"]}
        cur["sources"].extend(s for s in col["sources"] if (s["table"], s["column"]) not in seen)
        if cur["transform"] in ("source", "unknown"):
            cur.update({k: col[k] for k in ("transform", "expression", "path")})

    # --- statement handlers
    def ddl(self, st: Statement) -> None:
        n = self.node(st.target, "source")
        cols = st.ddl_columns or {}
        for c, t in cols.items():
            if c not in n["columns"]:
                n["columns"][c] = {"name": c, "type": t, "transform": "source", "expression": "", "path": [], "sources": []}
        self.register(st.target, cols.items())

    def query(self, st: Statement) -> None:
        n = self.node(st.target, st.kind if st.kind in ("table", "view", "query") else "table")
        n["upstream"] |= st.upstream
        try:
            q = qualify(st.query.copy(), schema=self.schema, dialect=self.d, db=DEFAULT_DB, validate_qualify_columns=False, identify=False)
        except Exception as e:
            self.problem("warning", "qualify_failed", f"Could not resolve all column references: {str(e).splitlines()[0][:200]}", st.file, st.target)
            q = st.query.copy()

        selects = q.selects if isinstance(q, exp.Query) else []
        if any(isinstance(s, exp.Star) or (isinstance(s, exp.Column) and isinstance(s.this, exp.Star)) for s in selects):
            self.problem("warning", "unresolved_star", "SELECT * reads a table whose columns are unknown (no DDL and not built here), so its columns cannot be traced.", st.file, st.target)

        names = [x for x in q.named_selects if x and x != "*"] if isinstance(q, exp.Query) else []
        outs = names
        if st.insert_columns and len(st.insert_columns) == len(names):
            outs = st.insert_columns
        elif st.kind == "insert":
            known = self.known(st.target)
            if known and len(known) == len(names):
                outs = known  # INSERT without a column list maps by position
        try:
            scope = build_scope(q)
        except Exception:
            scope = None

        for out, sel in zip(outs, names):
            col = self.trace(q, sel, scope, st)
            col["name"] = out.lower()
            self.add_column(n, col)
        self.register(st.target, ((c, n["columns"][c].get("type") or "string") for c in n["columns"]))
        n["indirect"].extend(self.indirect(q))

    def trace(self, q: exp.Expression, column: str, scope: Any, st: Statement) -> Json:
        try:
            if scope is not None:
                root = sg_lineage(column, q, schema=self.schema, dialect=self.d, scope=scope)
            else:
                root = sg_lineage(column, q, schema=self.schema, dialect=self.d)
        except Exception as e:
            self.problem("warning", "lineage_failed", f"Could not trace this column: {str(e).splitlines()[0][:200]}", st.file, st.target, column)
            return {"name": column, "type": None, "transform": "unknown", "expression": "", "path": [], "sources": []}

        sources: List[Json] = []
        seen: Set[Tuple[str, str]] = set()
        path: List[str] = []
        for node in root.walk():
            if node.downstream or not isinstance(node.source, exp.Table):
                # Intermediate steps, and leaves with no physical source (e.g. COUNT(*), literals).
                s = _expr_sql(node.expression, self.d)
                if s and s not in path:
                    path.append(s)
            else:
                key = (table_key(node.source), _ident(node.name.split(".")[-1]))
                if key not in seen:
                    seen.add(key)
                    sources.append({"table": key[0], "column": key[1]})
        return {
            "name": column,
            "type": None,
            "transform": classify_transform(root, sources, column),
            "expression": _expr_sql(root.expression, self.d),
            "path": path,
            "sources": sources,
        }

    def indirect(self, q: exp.Expression) -> List[Json]:
        """Columns that influence rows without flowing into them: filters, join keys, group-bys."""
        out: List[Json] = []
        seen: Set[Tuple[str, str, str]] = set()
        try:
            scopes = traverse_scope(q)
        except Exception:
            return out
        for scope in scopes:
            sel = scope.expression
            if not isinstance(sel, exp.Select):
                continue
            tables = {alias: src for alias, src in scope.sources.items() if isinstance(src, exp.Table)}
            parts: List[Tuple[str, Optional[exp.Expression]]] = [
                ("filter", sel.args.get("where")),
                ("filter", sel.args.get("having")),
                ("filter", sel.args.get("qualify")),
                ("group", sel.args.get("group")),
            ] + [("join", j.args.get("on")) for j in (sel.args.get("joins") or [])]
            for role, part in parts:
                if part is None:
                    continue
                for c in part.find_all(exp.Column):
                    src = tables.get(c.table)
                    if src is None:
                        continue
                    key = (table_key(src), c.name.lower(), role)
                    if key not in seen:
                        seen.add(key)
                        out.append({"table": key[0], "column": key[1], "role": role})
        return out

    def merge(self, st: Statement) -> None:
        m = st.merge
        n = self.node(st.target, "table")
        n["upstream"] |= st.upstream
        using = m.args.get("using")
        target_alias = m.this.alias_or_name.lower()
        src_alias = using.alias_or_name.lower() if using is not None else ""
        src_key = table_key(using) if isinstance(using, exp.Table) else None
        if src_key is None:
            self.problem("info", "merge_subquery", "MERGE uses a subquery source: lineage is traced at table level only.", st.file, st.target)
        whens = m.args.get("whens")
        mappings: List[Tuple[str, exp.Expression]] = []
        for w in (whens.expressions if whens is not None else []):
            then = w.args.get("then")
            if isinstance(then, exp.Update):
                for eq in then.expressions:
                    if isinstance(eq, exp.EQ) and isinstance(eq.this, exp.Column):
                        mappings.append((eq.this.name.lower(), eq.expression))
            elif isinstance(then, exp.Insert):
                cols = then.this.expressions if isinstance(then.this, exp.Tuple) else []
                vals = then.expression.expressions if isinstance(then.expression, exp.Tuple) else []
                mappings.extend((c.name.lower(), v) for c, v in zip(cols, vals))
        for tcol, e in mappings:
            srcs = []
            if src_key:
                for c in e.find_all(exp.Column):
                    if c.table.lower() == src_alias and (src_key, c.name.lower()) not in {(s["table"], s["column"]) for s in srcs}:
                        srcs.append({"table": src_key, "column": c.name.lower()})
            if isinstance(e, exp.Column):
                transform = "direct" if e.name.lower() == tcol else "renamed"
            else:
                transform = "derived" if srcs else "constant"
            self.add_column(n, {"name": tcol, "type": None, "transform": transform, "expression": e.sql(dialect=self.d), "path": [], "sources": srcs})
        on = m.args.get("on")
        if on is not None and src_key:
            for c in on.find_all(exp.Column):
                if c.table.lower() == src_alias:
                    n["indirect"].append({"table": src_key, "column": c.name.lower(), "role": "join"})
                elif c.table.lower() == target_alias:
                    n["indirect"].append({"table": st.target, "column": c.name.lower(), "role": "join"})
        self.register(st.target, ((c, "string") for c in n["columns"]))


def classify_transform(root: Any, sources: List[Json], name: str) -> str:
    kinds: Set[str] = set()
    for node in root.walk():
        # Physical-table leaves are plain column reads; everything else shapes the value.
        if not node.downstream and node is not root and isinstance(node.source, exp.Table):
            continue
        e = node.expression
        inner = e.this if isinstance(e, exp.Alias) else e
        if not isinstance(inner, exp.Expression):
            continue
        if inner.find(exp.Window):
            kinds.add("window")
        elif inner.find(exp.AggFunc):
            kinds.add("aggregate")
        elif isinstance(inner, (exp.Column, exp.Star)):
            continue
        elif isinstance(inner, (exp.Cast, exp.TryCast)) and isinstance(inner.this, exp.Column):
            kinds.add("cast")
        else:
            kinds.add("derived")
    for k in ("window", "aggregate"):
        if k in kinds:
            return k
    if not sources:
        return "constant"
    for k in ("derived", "cast"):
        if k in kinds:
            return k
    if len(sources) == 1 and sources[0]["column"] != name.lower():
        return "renamed"
    return "direct"


# ------------------------------------------------------------- splitting

def split_statements(text: str, dialect: str) -> List[Tuple[int, str]]:
    """Split on top-level semicolons using the dialect's own tokenizer."""
    d = sqlglot.Dialect.get_or_raise(dialect)
    tokens = d.tokenize(text)
    chunks: List[Tuple[int, str]] = []
    start = 0
    for tok in tokens:
        if tok.token_type == sqlglot.TokenType.SEMICOLON:
            chunk = text[start: tok.start]
            if chunk.strip():
                chunks.append((text.count("\n", 0, start) + 1, chunk))
            start = tok.end + 1
    tail = text[start:]
    if tail.strip():
        chunks.append((text.count("\n", 0, start) + 1, tail))
    return chunks


def _order(statements: List[Statement]) -> Tuple[List[Statement], List[str]]:
    writers: Dict[str, List[int]] = {}
    for i, st in enumerate(statements):
        if st.target:
            writers.setdefault(st.target, []).append(i)
    deps: Dict[int, Set[int]] = {i: set() for i in range(len(statements))}
    for j, st in enumerate(statements):
        for up in st.upstream:
            deps[j].update(i for i in writers.get(up, []) if i != j)
        if st.target:
            deps[j].update(i for i in writers[st.target] if i < j)  # DDL before CTAS before INSERT
    done: Set[int] = set()
    order: List[int] = []
    while len(order) < len(statements):
        ready = [i for i in range(len(statements)) if i not in done and deps[i] <= done]
        if not ready:
            break
        i = ready[0]
        done.add(i)
        order.append(i)
    cyclic = [i for i in range(len(statements)) if i not in done]
    cycle_tables = sorted({statements[i].target for i in cyclic if statements[i].target})
    return [statements[i] for i in order + cyclic], cycle_tables


def analyze_files(files: List[Json], dialect: str = "databricks") -> Json:
    t0 = time.perf_counter()
    eng = Engine(dialect)
    statements: List[Statement] = []
    jinja_files: List[str] = []

    for f in files:
        name = f.get("name") or "query.sql"
        text = f.get("sql") or ""
        if "{{" in text or "{%" in text:
            jinja_files.append(name)
            text = render_jinja(text)
        try:
            chunks = split_statements(text, dialect)
        except Exception as e:
            eng.problem("error", "parse_error", f"Could not tokenize: {str(e).splitlines()[0][:200]}", name)
            continue
        for line, chunk in chunks:
            try:
                parsed = sqlglot.parse(chunk, read=dialect)
            except Exception as e:
                eng.problem("error", "parse_error", f"Line {line}: {str(e).splitlines()[0][:240]}", name)
                continue
            for stmt in parsed:
                if stmt is None:
                    continue
                if isinstance(stmt, exp.Command):
                    # sqlglot falls back to a raw Command on syntax it cannot parse. That is fine for
                    # OPTIMIZE / VACUUM / SET, but a CREATE or INSERT we cannot read is a real gap.
                    keyword = str(stmt.this or "").upper()
                    if keyword in TRACEABLE_COMMANDS:
                        eng.problem("error", "parse_error", f"Line {line}: could not parse this {keyword} statement, so it was skipped.", name)
                    else:
                        eng.skipped += 1
                    continue
                st = classify_statement(stmt, name, len(statements), dialect)
                if st is None:
                    eng.skipped += 1
                    continue
                if st.query is not None:
                    st.upstream = physical_sources(st.query) - ({st.target} if st.kind != "query" else set())
                    st.has_star = _has_star(st.query)
                elif st.merge is not None:
                    using = st.merge.args.get("using")
                    st.upstream = {table_key(using)} if isinstance(using, exp.Table) else physical_sources(using) if using is not None else set()
                statements.append(st)

    if jinja_files:
        eng.problem("info", "jinja", f"dbt Jinja found in {len(jinja_files)} file(s): ref() was resolved by model name only. Load target/manifest.json for exact relations, docs and tests.")

    ordered, cycle = _order(statements)
    if cycle:
        eng.problem("error", "cycle", f"Circular dependency between: {', '.join(cycle)}. Lineage for these tables may be incomplete.")

    for st in ordered:
        eng.statements += 1
        n = eng.node(st.target, {"ddl": "source", "insert": "table", "merge": "table"}.get(st.kind, st.kind))
        if st.file not in n["files"]:
            n["files"].append(st.file)
        n["statements"].append({"kind": st.kind, "file": st.file, "sql": st.sql})
        if st.has_star:
            eng.problem("info", "select_star", "Uses SELECT *: new upstream columns will silently flow through.", st.file, st.target)
        if st.kind == "ddl":
            eng.ddl(st)
        elif st.kind == "merge":
            eng.merge(st)
        else:
            eng.query(st)

    # Tables read but never defined become external sources, with the columns we saw used.
    referenced: Dict[str, Dict[str, None]] = {}
    for n in list(eng.tables.values()):
        for up in n["upstream"]:
            referenced.setdefault(up, {})
        for c in n["columns"].values():
            for s in c["sources"]:
                referenced.setdefault(s["table"], {})[s["column"]] = None
        for s in n["indirect"]:
            referenced.setdefault(s["table"], {})[s["column"]] = None
    for key, cols in referenced.items():
        if key not in eng.tables:
            ext = eng.node(key, "external")
            for c in cols:
                ext["columns"][c] = {"name": c, "type": None, "transform": "source", "expression": "", "path": [], "sources": []}
        else:
            node = eng.tables[key]
            for c in cols:
                if c not in node["columns"] and node["kind"] in ("source", "external"):
                    node["columns"][c] = {"name": c, "type": None, "transform": "source", "expression": "", "path": [], "sources": []}

    tables = []
    edges = []
    column_edges = 0
    for n in eng.tables.values():
        cols = list(n["columns"].values())
        column_edges += sum(len(c["sources"]) for c in cols)
        tables.append({
            "id": n["id"],
            "kind": n["kind"],
            "files": n["files"],
            "statements": n["statements"],
            "columns": cols,
            "upstream": sorted(n["upstream"]),
            "indirect": n["indirect"],
            "description": n["description"],
        })
        edges.extend({"source": up, "target": n["id"]} for up in sorted(n["upstream"]))

    return {
        "version": ENGINE_VERSION,
        "sqlglot": sqlglot.__version__,
        "dialect": dialect,
        "tables": tables,
        "edges": edges,
        "problems": eng.problems,
        "meta": {"source": "sql"},
        "stats": {
            "files": len(files),
            "statements": eng.statements,
            "skipped": eng.skipped,
            "tables": len(tables),
            "columns": sum(len(t["columns"]) for t in tables),
            "column_edges": column_edges,
            "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
        },
    }


# ----------------------------------------------------------------- dbt

ADAPTER_DIALECT = {
    "databricks": "databricks", "spark": "spark", "snowflake": "snowflake", "bigquery": "bigquery",
    "postgres": "postgres", "redshift": "redshift", "duckdb": "duckdb", "trino": "trino",
    "sqlserver": "tsql", "fabric": "tsql", "synapse": "tsql", "athena": "athena",
}


def _rel(schema: Optional[str], name: str) -> str:
    return f"{(schema or DEFAULT_DB).lower()}.{name.lower()}"


def analyze_manifest(text: str, dialect: Optional[str] = None) -> Json:
    m = json.loads(text)
    meta = m.get("metadata") or {}
    adapter = meta.get("adapter_type")
    d = dialect or ADAPTER_DIALECT.get(adapter or "", "databricks")
    nodes: Dict[str, Json] = m.get("nodes") or {}
    sources: Dict[str, Json] = m.get("sources") or {}

    rel: Dict[str, str] = {}
    for uid, n in nodes.items():
        if n.get("resource_type") in ("model", "seed", "snapshot"):
            rel[uid] = _rel(n.get("schema"), n.get("alias") or n["name"])
    for uid, s in sources.items():
        rel[uid] = _rel(s.get("schema"), s.get("identifier") or s["name"])
    by_name = {n["name"]: rel[uid] for uid, n in nodes.items() if uid in rel}
    by_source = {(s.get("source_name"), s.get("name")): rel[uid] for uid, s in sources.items()}

    files: List[Json] = []
    for uid, s in sources.items():
        cols = s.get("columns") or {}
        if cols:
            defs = ", ".join(f"{c} {(v or {}).get('data_type') or 'string'}" for c, v in cols.items())
            files.append({"name": f"sources/{s.get('source_name')}.yml", "sql": f"CREATE TABLE {rel[uid]} ({defs})"})
    for uid, n in nodes.items():
        if n.get("resource_type") == "seed" and n.get("columns"):
            defs = ", ".join(f"{c} {(v or {}).get('data_type') or 'string'}" for c, v in n["columns"].items())
            files.append({"name": n.get("original_file_path") or uid, "sql": f"CREATE TABLE {rel[uid]} ({defs})"})
    for uid, n in nodes.items():
        if n.get("resource_type") not in ("model", "snapshot"):
            continue
        sql = n.get("compiled_code") or n.get("compiled_sql")
        if not sql:
            sql = render_jinja(n.get("raw_code") or n.get("raw_sql") or "", by_name, by_source)
        materialized = ((n.get("config") or {}).get("materialized") or "view").lower()
        kw = "VIEW" if materialized in ("view", "ephemeral") else "TABLE"
        body = sql.strip().rstrip(";")
        files.append({"name": n.get("original_file_path") or n.get("path") or uid, "sql": f"CREATE OR REPLACE {kw} {rel[uid]} AS\n{body}"})

    result = analyze_files(files, d)
    by_id = {t["id"]: t for t in result["tables"]}

    # Docs
    for uid, n in list(nodes.items()) + list(sources.items()):
        t = by_id.get(rel.get(uid, ""))
        if not t:
            continue
        t["description"] = n.get("description") or t.get("description")
        t["dbt"] = {"unique_id": uid, "materialized": (n.get("config") or {}).get("materialized"), "tags": n.get("tags") or [], "path": n.get("original_file_path")}
        docs = {c.lower(): (v or {}).get("description") for c, v in (n.get("columns") or {}).items()}
        for c in t["columns"]:
            if docs.get(c["name"]):
                c["description"] = docs[c["name"]]

    # Tests
    for uid, n in nodes.items():
        if n.get("resource_type") != "test":
            continue
        tm = n.get("test_metadata") or {}
        attached = n.get("attached_node") or next((x for x in (n.get("depends_on") or {}).get("nodes") or [] if x in rel), None)
        t = by_id.get(rel.get(attached or "", ""))
        if not t:
            continue
        test = {"name": tm.get("name") or n.get("name"), "unique_id": uid}
        col = (n.get("column_name") or (tm.get("kwargs") or {}).get("column_name") or "").lower()
        target = next((c for c in t["columns"] if c["name"] == col), None) if col else None
        if target is not None:
            target.setdefault("tests", []).append(test)
        else:
            t.setdefault("tests", []).append(test)

    result["meta"] = {"source": "dbt", "adapter": adapter, "project": meta.get("project_name"), "dbt_version": meta.get("dbt_version")}
    return result


# ------------------------------------------------------------ entry point

def analyze_json(payload: str) -> str:
    """JSON in, JSON out. payload: {"files": [{"name","sql"}], "dialect": "..."} or {"manifest": "...", "dialect": "..."}."""
    p = json.loads(payload)
    if p.get("manifest"):
        res = analyze_manifest(p["manifest"], p.get("dialect"))
    else:
        res = analyze_files(p.get("files") or [], p.get("dialect") or "databricks")
    return json.dumps(res)
