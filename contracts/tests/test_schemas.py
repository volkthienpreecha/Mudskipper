"""Every schema is valid draft 2020-12, has a stable $id, and every $ref resolves."""
import json
import pathlib
import unittest

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = pathlib.Path(__file__).resolve().parents[1] / "schemas"
BASE = "https://mudskipper.invalid/schemas/v1/"


def load_all():
    return {p: json.loads(p.read_text(encoding="utf-8")) for p in sorted(ROOT.rglob("*.schema.json"))}


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.schemas = load_all()
        self.registry = Registry().with_resources(
            [(s["$id"], Resource.from_contents(s)) for s in self.schemas.values()]
        )

    def test_expected_set(self):
        names = {str(p.relative_to(ROOT)) for p in self.schemas}
        artifacts = {"aoi", "passes", "fields", "observation", "field_summary", "detectability", "district_check",
                     "checks", "provenance", "overlays_index", "story", "claims", "live", "common", "states"}
        api = {"health", "meta", "story", "passes", "fields_page", "field_detail", "detectability", "checks",
               "provenance", "states", "audit_request", "audit_response", "error"}
        expected = {f"{n}.schema.json" for n in artifacts} | {f"api/{n}.schema.json" for n in api}
        self.assertEqual(names, expected)

    def test_metaschema_and_ids(self):
        for path, schema in self.schemas.items():
            with self.subTest(path=path.name):
                Draft202012Validator.check_schema(schema)
                self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
                self.assertEqual(schema["$id"], BASE + str(path.relative_to(ROOT)))
                self.assertTrue(schema.get("title") and schema.get("description"))

    def test_all_refs_resolve(self):
        def walk(node, resolver):
            if isinstance(node, dict):
                if "$ref" in node:
                    resolver.lookup(node["$ref"])  # raises if unresolvable
                for value in node.values():
                    walk(value, resolver)
            elif isinstance(node, list):
                for value in node:
                    walk(value, resolver)

        for schema in self.schemas.values():
            walk(schema, self.registry.resolver(schema["$id"]))

    def test_files_are_canonical(self):
        """2-space JSON, LF, trailing newline: keeps diffs reviewable."""
        for path, schema in self.schemas.items():
            text = path.read_text(encoding="utf-8")
            self.assertEqual(text, json.dumps(schema, indent=2, ensure_ascii=False) + "\n", path.name)


if __name__ == "__main__":
    unittest.main()
