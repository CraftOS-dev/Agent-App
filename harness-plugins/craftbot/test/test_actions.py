"""Tests for the CraftBot actions, runnable without CraftBot.

    python harness-plugins/craftbot/test/test_actions.py

Standard library plus Node: the module is imported with a stand-in for
CraftBot's `agent_core.action` that records each action, and the framework
CLIs are the integration starter's fake (`fake-cli.mjs`, copied as
`agent-app.mjs` and `a2app.mjs`), which answers in the packaging contract's
shapes and reports which binary ran and with what argv.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
FAKE_CLI = PLUGIN.parent / "integration-starter" / "test" / "fake-cli.mjs"
NODE = shutil.which("node")


def load_actions() -> tuple[types.ModuleType, dict]:
    """Import the module as CraftBot does, with `@action` recording what it registers."""
    registered: dict = {}

    def action(name, **meta):
        def register(fn):
            assert name not in registered, name
            registered[name] = {"fn": fn, **meta}
            return fn
        return register

    sys.modules["agent_core"] = types.SimpleNamespace(action=action)
    name = "agent_app_craftbot_actions"
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module, registered


def sample(spec: dict):
    """A value for an input field, from its schema: its example, else one of its type."""
    if "example" in spec:
        return spec["example"]
    return {"string": "x", "integer": 1, "boolean": True, "object": {}}.get(spec.get("type"), "x")


@unittest.skipIf(NODE is None, "node is required for the fake framework CLIs")
class Actions(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="a2app-craftbot-"))
        for binary in ("agent-app", "a2app"):
            shutil.copyfile(FAKE_CLI, self.dir / f"{binary}.mjs")
        self.saved = dict(os.environ)
        os.environ.update({
            "A2APP_HOME": str(self.dir / "home"),
            "AGENT_APP_CLI": str(self.dir / "agent-app.mjs"),
            "A2APP_CLI": str(self.dir / "a2app.mjs"),
        })
        self.module, self.actions = load_actions()

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self.saved)
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_action(self, action: str, /, **args) -> dict:
        return self.actions[action]["fn"](args)

    def ran(self, out: dict) -> tuple[str, list]:
        doc = json.loads(out["output"])
        return doc["bin"], doc["argv"]

    def test_every_action_reads_only_what_its_schema_declares(self) -> None:
        # A field a handler reads but its schema lacks is one no caller is told to send.
        for name, meta in self.actions.items():
            args = {key: sample(spec) for key, spec in meta["input_schema"].items()}
            with self.subTest(action=name):
                out = meta["fn"](args)
                self.assertIn(out["status"], ("success", "error"))
                self.assertEqual(meta["action_sets"], ["agent_app"])

    def test_each_action_runs_the_binary_that_owns_it(self) -> None:
        # An app module named like a build verb is still operated with a2app.
        self.assertEqual(self.ran(self.run_action("agent_app_run_operation", dir="crm", path="validate/runs", operation="go", fields={"n": 1})),
                         ("a2app", ["crm", "validate", "runs", "go", "--n", "1"]))
        self.assertEqual(self.ran(self.run_action("agent_app_find", dir="crm", term="invoice")), ("a2app", ["crm", "--find", "invoice"]))
        self.assertEqual(self.ran(self.run_action("agent_app_validate", dir="crm", no_build="true")), ("agent-app", ["crm", "validate", "--no-build"]))
        self.assertEqual(self.ran(self.run_action("agent_app_build", dir="crm", blueprint="blueprint-base")), ("agent-app", ["crm", "scaffold", "--blueprint", "blueprint-base"]))

    def test_marketplace_list_and_install_keep_craftbots_names(self) -> None:
        listed = self.run_action("agent_app_marketplace_list")
        self.assertEqual(listed["status"], "success")
        self.assertEqual([a["id"] for a in listed["apps"]], ["kanban-board", "kanban-online"])
        self.assertIn("agent_app_marketplace_install", listed["message"])
        out = self.run_action("agent_app_marketplace_install", app_id="kanban-board", name="Team", description="ignored", custom_fields={"APP_TITLE": "Team board"})
        self.assertEqual(out["status"], "success")
        self.assertEqual(out["result"]["argv"], ["install", "kanban-board", "--name", "Team", "--set", "APP_TITLE=Team board"])
        self.assertEqual((out["project_id"], out["project_path"], out["trust"]), ("0123456789ab", "/apps/Team", "catalogued"))
        self.assertIn("http://127.0.0.1:8123/", out["message"])
        self.assertEqual(self.run_action("agent_app_marketplace_install")["exit_code"], 2)

    def test_inspect_and_import_report_what_a_source_is(self) -> None:
        out = self.run_action("agent_app_inspect", source="./foreign-site")
        self.assertEqual(out["status"], "success")
        self.assertEqual(out["report"]["argv"], ["inspect", "--from", "./foreign-site"])
        self.assertIn("adopt, convert", out["message"])
        out = self.run_action("agent_app_import", source="./board.zip", name="Board")
        self.assertEqual(out["status"], "success")
        self.assertEqual(out["result"]["argv"], ["install", "--from", "./board.zip", "--name", "Board"])
        self.assertIn("walk-verify", out["message"], "an import owes a walk-verify, and says so")
        refused = self.run_action("agent_app_import", source="./living-ui-app")
        self.assertEqual((refused["status"], refused["exit_code"]), ("error", 1))
        self.assertIn("importer skill to convert", refused["message"], "a source that is not a package is sent where it belongs")

    def test_a_missing_cli_names_the_package_to_install(self) -> None:
        os.environ["AGENT_APP_CLI"] = "definitely-not-agent-app-xyz"
        module, actions = load_actions()
        out = actions["agent_app_marketplace_list"]["fn"]({})
        self.assertEqual(out["status"], "error")
        self.assertIn("npm i -g agent-app-framework", out["message"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
