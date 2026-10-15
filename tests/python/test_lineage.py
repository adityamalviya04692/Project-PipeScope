"""Tests for the lineage engine (runs under plain CPython with sqlglot installed)."""
import json
import random
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src" / "python"))

import pipescope_lineage as pl  # noqa: E402

SAMPLE = sorted((ROOT / "public" / "sample" / "sql").glob("*.sql"))


def load_sample():
    return [{"name": p.name, "sql": p.read_text()} for p in SAMPLE]


def run(*sqls, dialect="databricks"):
    return pl.analyze_files([{"name": f"f{i}.sql", "sql": s} for i, s in enumerate(sqls)], dialect)


def table(res, key):
    return next(t for t in res["tables"] if t["id"] == key)


def col(res, key, name):
    return next(c for c in table(res, key)["columns"] if c["name"] == name)


def srcs(c):
    return sorted(f"{s['table']}.{s['column']}" for s in c["sources"])


@pytest.fixture(scope="module")
def sample():
    return pl.analyze_files(load_sample(), "databricks")


# --------------------------------------------------------------- sample

def test_sample_project_tables_and_kinds(sample):
    kinds = {t["id"]: t["kind"] for t in sample["tables"]}
    assert kinds["bronze.raw_orders"] == "source"
    assert kinds["gold.fct_order_items"] == "table"
    assert kinds["reporting.v_vip_customers"] == "view"
    assert sample["stats"]["tables"] == 17
    assert not [p for p in sample["problems"] if p["severity"] == "error"]


def test_sample_column_lineage_through_joins_ctes_and_aggregates(sample):
    assert srcs(col(sample, "gold.fct_order_items", "customer_id")) == ["silver.orders.customer_id"]
    assert srcs(col(sample, "silver.order_items", "line_amount")) == [
        "bronze.raw_order_items.discount_pct",
        "bronze.raw_order_items.quantity",
        "bronze.raw_order_items.unit_price",
    ]
    gross = col(sample, "gold.fct_orders", "gross_amount")
    assert gross["transform"] == "aggregate"
    assert srcs(gross) == ["gold.fct_order_items.line_amount"]
    assert "SUM(fct_order_items.line_amount)" in gross["path"]
    assert srcs(col(sample, "gold.dim_customers", "lifetime_value")) == ["gold.fct_orders.gross_amount"]


def test_transform_classification(sample):
    assert col(sample, "silver.orders", "order_date")["transform"] == "cast"
    assert col(sample, "silver.orders", "status")["transform"] == "derived"
    assert col(sample, "silver.orders", "order_id")["transform"] == "direct"
    assert col(sample, "gold.fct_orders", "items")["transform"] == "aggregate"  # COUNT(*) inside a CTE
    assert col(sample, "gold.mart_customer_ltv", "rank_in_segment")["transform"] == "window"
    assert col(sample, "gold.mart_customer_ltv", "segment")["transform"] == "derived"


def test_select_star_is_expanded_and_flagged(sample):
    vip = table(sample, "reporting.v_vip_customers")
    assert [c["name"] for c in vip["columns"]] == [c["name"] for c in table(sample, "gold.mart_customer_ltv")["columns"]]
    stars = {p["table"] for p in sample["problems"] if p["code"] == "select_star"}
    assert stars == {"silver.orders", "reporting.v_vip_customers"}


def test_indirect_lineage_captures_filters_and_join_keys(sample):
    ind = {(i["table"], i["column"], i["role"]) for i in table(sample, "gold.fct_order_items")["indirect"]}
    assert ("silver.orders", "status", "filter") in ind
    assert ("silver.products", "product_id", "join") in ind


def test_file_order_does_not_matter():
    files = load_sample()
    shuffled = files[:]
    random.Random(7).shuffle(shuffled)
    a = pl.analyze_files(files)
    b = pl.analyze_files(shuffled)
    key = lambda r: sorted((t["id"], c["name"], tuple(srcs(c))) for t in r["tables"] for c in t["columns"])
    assert key(a) == key(b)


# ---------------------------------------------------------- statements

def test_insert_maps_columns_by_position():
    res = run(
        "CREATE TABLE gold.t (a INT, b STRING)",
        "INSERT INTO gold.t SELECT x + 1, UPPER(y) FROM silver.s",
        "INSERT INTO gold.t (b, a) SELECT name, id FROM silver.u",
    )
    assert srcs(col(res, "gold.t", "a")) == ["silver.s.x", "silver.u.id"]
    assert srcs(col(res, "gold.t", "b")) == ["silver.s.y", "silver.u.name"]


def test_merge_maps_update_and_insert_clauses():
    res = run(
        """MERGE INTO silver.customers t USING bronze.raw_customers s ON t.id = s.id
           WHEN MATCHED THEN UPDATE SET t.name = UPPER(s.name), t.city = s.city
           WHEN NOT MATCHED THEN INSERT (id, name, city) VALUES (s.id, s.name, s.city)"""
    )
    assert srcs(col(res, "silver.customers", "name")) == ["bronze.raw_customers.name"]
    assert col(res, "silver.customers", "name")["transform"] == "derived"
    assert table(res, "silver.customers")["upstream"] == ["bronze.raw_customers"]


def test_unknown_tables_become_external_sources():
    res = run("CREATE TABLE gold.x AS SELECT a.id, b.v FROM ext.a a JOIN ext.b b ON a.id = b.id")
    ext = table(res, "ext.a")
    assert ext["kind"] == "external"
    assert {c["name"] for c in ext["columns"]} == {"id"}


def test_unresolved_star_is_reported():
    res = run("CREATE TABLE gold.x AS SELECT * FROM ext.unknown")
    assert any(p["code"] == "unresolved_star" for p in res["problems"])


def test_one_bad_statement_does_not_lose_the_file():
    res = run("CREATE TABLE a.ok AS SELECT 1 AS n; CREATE TABLE a.bad AS SELEC oops FROM; CREATE TABLE a.ok2 AS SELECT n FROM a.ok")
    assert {t["id"] for t in res["tables"]} >= {"a.ok", "a.ok2"}
    errors = [p for p in res["problems"] if p["code"] == "parse_error"]
    assert len(errors) == 1 and errors[0]["file"] == "f0.sql"
    assert col(res, "a.ok", "n")["transform"] == "constant"


def test_cycles_are_detected():
    res = run("CREATE TABLE a.x AS SELECT v FROM a.y", "CREATE TABLE a.y AS SELECT v FROM a.x")
    assert any(p["code"] == "cycle" for p in res["problems"])


def test_unqualified_tables_use_the_default_database():
    res = run("CREATE TABLE out AS SELECT id FROM src")
    assert srcs(col(res, "default.out", "id")) == ["default.src.id"]


def test_other_dialects():
    res = run('CREATE TABLE "mart"."t" AS SELECT "o"."id" AS order_id FROM "raw"."orders" AS "o" WHERE "o"."ts" > NOW()', dialect="postgres")
    assert srcs(col(res, "mart.t", "order_id")) == ["raw.orders.id"]


# ----------------------------------------------------------------- dbt

def test_jinja_in_plain_sql_is_rendered():
    res = run("{{ config(materialized='table') }}\nCREATE TABLE marts.m AS SELECT id FROM {{ ref('stg_orders') }} {% if is_incremental() %} WHERE x > 1 {% endif %}")
    assert srcs(col(res, "marts.m", "id")) == ["default.stg_orders.id"]
    assert any(p["code"] == "jinja" for p in res["problems"])


MANIFEST = {
    "metadata": {"adapter_type": "postgres", "project_name": "shop", "dbt_version": "1.8.0"},
    "sources": {
        "source.shop.raw.orders": {"name": "orders", "source_name": "raw", "schema": "raw", "identifier": "orders",
                                    "columns": {"id": {"data_type": "integer"}, "amount": {"data_type": "numeric"}}},
    },
    "nodes": {
        "model.shop.stg_orders": {
            "resource_type": "model", "name": "stg_orders", "schema": "staging", "alias": "stg_orders",
            "config": {"materialized": "view"}, "description": "Cleaned orders",
            "columns": {"order_id": {"description": "Primary key"}},
            "compiled_code": 'select id as order_id, amount * 100 as amount_cents from "db"."raw"."orders"',
            "original_file_path": "models/staging/stg_orders.sql",
        },
        "model.shop.fct": {
            "resource_type": "model", "name": "fct", "schema": "marts", "config": {"materialized": "table"},
            "raw_code": "select order_id, sum(amount_cents) as total from {{ ref('stg_orders') }} group by 1",
            "original_file_path": "models/marts/fct.sql",
        },
        "test.shop.unique_stg_orders_order_id": {
            "resource_type": "test", "name": "unique_stg_orders_order_id", "column_name": "order_id",
            "test_metadata": {"name": "unique", "kwargs": {"column_name": "order_id"}}, "attached_node": "model.shop.stg_orders",
        },
    },
}


def test_dbt_manifest_lineage_docs_and_tests():
    res = json.loads(pl.analyze_json(json.dumps({"manifest": json.dumps(MANIFEST)})))
    assert res["dialect"] == "postgres"
    assert res["meta"]["project"] == "shop"
    assert srcs(col(res, "marts.fct", "total")) == ["staging.stg_orders.amount_cents"]
    assert srcs(col(res, "staging.stg_orders", "amount_cents")) == ["raw.orders.amount"]
    stg = table(res, "staging.stg_orders")
    assert stg["description"] == "Cleaned orders"
    oid = col(res, "staging.stg_orders", "order_id")
    assert oid["description"] == "Primary key"
    assert oid["tests"][0]["name"] == "unique"
    assert table(res, "raw.orders")["kind"] == "source"
