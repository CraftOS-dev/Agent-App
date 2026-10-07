"""Tests for the Hermes plugin, runnable without a Hermes install.

    python harness-plugins/hermes/test/test_plugin.py

Standard library only, plus Node (the fake framework CLIs are .js entries, as
a real `A2APP_CLI`/`AGENT_APP_CLI` override would be) and, for the dashboard
API, FastAPI (Hermes's own dependency; those tests are skipped without it).

The plugin is loaded the way Hermes's loader loads a directory plugin (a
`hermes_plugins.<slug>` package from `__init__.py`), and the dashboard backend
the way the dashboard loads it (a standalone module from its file, mounted at
`/api/plugins/agent-app`). Hermes itself is replaced by fakes of the exact
surfaces the plugin touches: the PluginContext methods, and a `hermes` binary
that records what it was run with and writes a transcript.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import types
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
REPO = PLUGIN.parent.parent
STARTER_DIST = REPO / "harness-plugins" / "integration-starter" / "dist" / "index.js"
NODE = shutil.which("node")

FAKE_CLI = """
const fs = require("fs");
const BIN = %(bin)s;
const argv = process.argv.slice(2);
if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ bin: BIN, argv, cwd: process.cwd() }) + "\\n");
if (BIN === "agent-app" && argv[0] === "skills" && argv[1] === "--path") { console.log(process.env.FAKE_SKILLS_DIR || ""); process.exit(process.env.FAKE_SKILLS_DIR ? 0 : 1); }
if (BIN === "agent-app" && argv[0] === "list") {
  const f = process.env.FAKE_REGISTRY;
  console.log(f && fs.existsSync(f) ? fs.readFileSync(f, "utf8") : JSON.stringify({ ok: true, apps: [] }));
  process.exit(0);
}
if (argv.includes("BAD")) { console.log(JSON.stringify({ ok: false, error: { code: "invalid_enum", field: "status" } })); console.error("rejected by the guard"); process.exit(1); }
console.log(JSON.stringify({ ok: true, bin: BIN, argv }));
"""

FAKE_HERMES = """
import json, os, sys, time
args = sys.argv[1:]
message = sys.stdin.read()
sid = args[args.index("--resume") + 1]
record = {"argv": args, "cwd": os.getcwd(), "message": message, "start": time.time(),
          "env": {k: os.environ.get(k) for k in ("HERMES_TUI", "HERMES_SESSION_KEY", "HERMES_GATEWAY_SESSION", "KEEP_ME")}}
time.sleep(float(os.environ.get("FAKE_TURN_DELAY", "0")))
record["end"] = time.time()
with open(os.environ["FAKE_HERMES_CALLS"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps(record) + "\\n")
if "FAIL" in message:
    print("Error: no API key configured for provider 'openrouter'")
    sys.exit(1)
with open(os.path.join(os.environ["FAKE_STORE"], sid + ".jsonl"), "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"role": "user", "content": message}) + "\\n")
    fh.write(json.dumps({"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "terminal"}}]}) + "\\n")
    fh.write(json.dumps({"role": "tool", "tool_name": "terminal", "content": "{\\"output\\": \\"ok\\"}"}) + "\\n")
    fh.write(json.dumps({"role": "assistant", "content": "Done."}) + "\\n")
print("Done.")
"""


def load_plugin():
    """Import the plugin as Hermes does: package `hermes_plugins.agent_app`."""
    if "hermes_plugins" not in sys.modules:
        ns = types.ModuleType("hermes_plugins")
        ns.__path__ = []
        ns.__package__ = "hermes_plugins"
        sys.modules["hermes_plugins"] = ns
    name = "hermes_plugins.agent_app"
    for key in [k for k in sys.modules if k == name or k.startswith(name + ".")]:
        del sys.modules[key]
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
    module = importlib.util.module_from_spec(spec)
    module.__package__ = name
    module.__path__ = [str(PLUGIN)]
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_dashboard_api():
    """Import the dashboard backend as the dashboard does: a standalone module."""
    name = "hermes_dashboard_plugin_agent-app"
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class FakeContext:
    """The PluginContext surface the plugin uses, recording each call."""

    def __init__(self, inject_ok: bool = True) -> None:
        self.manifest = types.SimpleNamespace(name="agent-app", key="agent-app")
        self.tools: dict[str, dict] = {}
        self.skills: dict[str, dict] = {}
        self.sections: dict[str, str] = {}
        self.commands: dict[str, dict] = {}
        self.hooks: dict[str, object] = {}
        self.cli: dict[str, dict] = {}
        self.injected: list[str] = []
        self.inject_ok = inject_ok

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False, description="", emoji="", override=False):
        assert name not in self.tools, name
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "emoji": emoji, "is_async": is_async}

    def register_skill(self, name, path, description="", frontmatter=None):
        assert ":" not in name and Path(path).exists()
        self.skills[f"{self.manifest.name}:{name}"] = {"path": Path(path), "description": description, "frontmatter": dict(frontmatter or {})}

    def register_system_prompt_section(self, id, content, *, position="after_memory", max_chars=4000):
        assert id not in self.sections
        self.sections[id] = content

    def register_command(self, name, handler, description="", args_hint="", argument_mode=None):
        self.commands[name] = {"handler": handler, "description": description, "args_hint": args_hint, "argument_mode": argument_mode}

    def register_hook(self, hook_name, callback):
        self.hooks[hook_name] = callback

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, description=""):
        self.cli[name] = {"help": help, "setup_fn": setup_fn, "handler_fn": handler_fn}

    def inject_message(self, content, role="user", *, session_key=None):
        self.injected.append(content)
        return self.inject_ok


class Sandbox:
    """A throwaway framework home with fake CLIs and env pointing at them."""

    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="a2app-hermes-"))
        self.home = self.dir / "home"
        self.calls = self.dir / "calls.jsonl"
        self.registry = self.dir / "registry.json"
        for binary in ("agent-app", "a2app"):
            (self.dir / f"{binary}.js").write_text(FAKE_CLI % {"bin": json.dumps(binary)}, encoding="utf-8")
        self.saved = dict(os.environ)
        os.environ.update({
            "A2APP_HOME": str(self.home),
            "AGENT_APP_CLI": str(self.dir / "agent-app.js"),
            "A2APP_CLI": str(self.dir / "a2app.js"),
            "FAKE_CALLS": str(self.calls),
            "FAKE_REGISTRY": str(self.registry),
            "FAKE_SKILLS_DIR": str(REPO / "skills"),
        })
        os.environ.pop("TERMINAL_CWD", None)

    def set_registry(self, apps: list[dict]) -> None:
        self.registry.write_text(json.dumps({"ok": True, "apps": apps}), encoding="utf-8")

    def recorded(self) -> list[dict]:
        if not self.calls.exists():
            return []
        return [json.loads(line) for line in self.calls.read_text(encoding="utf-8").splitlines() if line]

    def close(self) -> None:
        os.environ.clear()
        os.environ.update(self.saved)
        shutil.rmtree(self.dir, ignore_errors=True)


@unittest.skipIf(NODE is None, "node is required for the fake framework CLIs")
class PluginRegistration(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()
        self.plugin = load_plugin()
        self.ctx = FakeContext()
        self.plugin.register(self.ctx)

    def tearDown(self) -> None:
        self.box.close()

    def call(self, tool: str, **args) -> str:
        return self.ctx.tools[tool]["handler"](args, task_id="t1", session_id="s1")

    def test_registers_the_engines_seventeen_tools(self) -> None:
        names = set(self.ctx.tools)
        self.assertEqual(len(names), 17)
        if STARTER_DIST.parent.parent.joinpath("src", "index.ts").exists():
            import re
            ts = (STARTER_DIST.parent.parent / "src" / "index.ts").read_text(encoding="utf-8")
            self.assertEqual(names, set(re.findall(r'name: "(agent_app_\w+)"', ts)), "same tool set as the TypeScript engine")
        manifest = (PLUGIN / "plugin.yaml").read_text(encoding="utf-8")
        for name in names:
            self.assertIn(f"  - {name}\n", manifest, "provides_tools lists every registered tool")
            tool = self.ctx.tools[name]
            self.assertEqual(tool["toolset"], "agent_app")
            self.assertEqual(tool["schema"]["name"], name)
            self.assertEqual(tool["schema"]["parameters"]["type"], "object")
            self.assertFalse(tool["is_async"])

    def test_tools_shell_the_owning_binary_with_literal_argv(self) -> None:
        out = json.loads(self.call("agent_app_describe", dir="/apps/crm", path="sales/invoices/INV-1", all=True))
        self.assertEqual((out["bin"], out["argv"]), ("a2app", ["/apps/crm", "sales", "invoices", "INV-1", "--all"]))
        out = json.loads(self.call("agent_app_create", dir="crm", entity="deals", fields={"title": 'x & "y" | z', "amount": 5}))
        self.assertEqual(out["argv"], ["crm", "data", "deals", "create", "--json", '{"title":"x & \\"y\\" | z","amount":5}'])
        out = json.loads(self.call("agent_app_run_operation", dir="crm", path="sales/invoices/INV-1", operation="void", fields={"reason": "dup"}, approve="k1"))
        self.assertEqual(out["argv"], ["crm", "sales", "invoices", "INV-1", "void", "--reason", "dup", "--approve", "k1"])
        out = json.loads(self.call("agent_app_build", dir="crm", blueprint="blueprint-base", name="CRM"))
        self.assertEqual((out["bin"], out["argv"]), ("agent-app", ["crm", "scaffold", "--blueprint", "blueprint-base", "--name", "CRM"]))
        out = json.loads(self.call("agent_app_open", dir="crm", printOnly=True))
        self.assertEqual((out["bin"], out["argv"]), ("agent-app", ["crm", "open", "--print-only"]))

    def test_a_guard_rejection_reaches_the_model(self) -> None:
        text = self.call("agent_app_update", dir="crm", entity="deals", id="BAD", fields={"status": "nope"})
        self.assertIn('"invalid_enum"', text)
        self.assertIn("rejected by the guard", text)

    def test_a_relative_dir_resolves_in_the_agents_terminal(self) -> None:
        os.environ["TERMINAL_CWD"] = str(self.box.dir)
        self.call("agent_app_get", dir=".", entity="deals", id="D1")
        self.assertEqual(Path(self.box.recorded()[-1]["cwd"]).resolve(), self.box.dir.resolve())

    def test_missing_cli_is_reported_with_the_install_hint(self) -> None:
        os.environ["A2APP_CLI"] = "definitely-not-a2app-xyz"
        text = self.call("agent_app_list", dir="crm", entity="deals")
        self.assertIn("framework CLI not found", text)
        self.assertIn("npm i -g agent-app-framework", text)

    def test_ships_the_six_skills_and_routes_to_them(self) -> None:
        self.assertEqual(set(self.ctx.skills), {f"agent-app:{n}" for n in ("creator", "modify", "importer", "operator", "walk-verify", "connect")})
        for skill in self.ctx.skills.values():
            self.assertTrue(skill["description"])
        section = self.ctx.sections["agent-app"]
        self.assertLessEqual(len(section), 4000, "Hermes caps a prompt section at 4000 characters")
        for name in self.ctx.skills:
            self.assertIn(f"`{name}`", section)
        self.assertIn(self.plugin.ROUTED_PREFIX, section)
        self.assertIn(str(REPO / "skills"), section, "skills found through `agent-app skills --path`")

    def test_slash_command_hands_the_request_to_the_agent(self) -> None:
        cmd = self.ctx.commands["agent-app"]
        self.assertEqual(cmd["argument_mode"], "text")
        self.assertIn("Usage", cmd["handler"]("   "))
        self.assertIsNone(cmd["handler"]("build a CRM"))
        self.assertEqual(self.ctx.injected, [f"{self.plugin.ROUTED_PREFIX} build a CRM"])
        self.assertFalse(self.ctx.injected[0].startswith("/"), "injected text must not re-enter command dispatch")
        self.ctx.inject_ok = False
        self.assertEqual(cmd["handler"]("build a CRM"), self.plugin.NO_TURN_HERE)

    def test_gateway_command_is_rewritten_into_a_request(self) -> None:
        hook = self.ctx.hooks["pre_gateway_dispatch"]
        event = lambda text: types.SimpleNamespace(text=text)
        self.assertEqual(hook(event=event("/agent-app build a CRM"), gateway=None, session_store=None),
                         {"action": "rewrite", "text": f"{self.plugin.ROUTED_PREFIX} build a CRM"})
        self.assertEqual(hook(event=event("/agent_app@hermes_bot add a report"))["text"], f"{self.plugin.ROUTED_PREFIX} add a report")
        self.assertIsNone(hook(event=event("/agent-app")), "a bare command reaches its handler for usage")
        self.assertIsNone(hook(event=event("/agent-apps x")))
        self.assertIsNone(hook(event=event("build a CRM")))
        self.assertIsNone(hook(event=types.SimpleNamespace(text=None)))

    def test_cli_passthrough_routes_by_verb_and_keeps_flags(self) -> None:
        entry = self.ctx.cli["agent-app"]
        parser = argparse.ArgumentParser(prog="hermes agent-app")
        entry["setup_fn"](parser)
        args = parser.parse_args(["./crm", "validate", "--no-build"])
        self.assertEqual(args.argv, ["./crm", "validate", "--no-build"])
        self.assertEqual(entry["handler_fn"](args), 0)
        last = self.box.recorded()[-1]
        self.assertEqual((last["bin"], last["argv"]), ("agent-app", ["./crm", "validate", "--no-build"]))
        self.assertEqual(entry["handler_fn"](parser.parse_args(["crm", "tasks", "next"])), 0)
        self.assertEqual(self.box.recorded()[-1]["bin"], "a2app")
        self.assertEqual(entry["handler_fn"](parser.parse_args(["crm", "data", "deals", "get", "BAD"])), 1, "exit code propagates")
        self.assertEqual(entry["handler_fn"](parser.parse_args([])), 2)

    def test_registers_the_hermes_bridge_route(self) -> None:
        doc = json.loads((self.box.home / "harnesses.json").read_text(encoding="utf-8"))
        self.assertEqual(doc, {"version": 1, "harnesses": [self.plugin.HERMES_PROFILE]})
        route = self.plugin.HERMES_PROFILE["routes"][0]
        self.assertEqual(route["command"], "hermes")
        self.assertEqual(route["args"].count("{prompt}"), 1)


@unittest.skipIf(NODE is None, "node is required for the fake framework CLIs")
class Engine(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()
        self.engine = load_plugin().engine

    def tearDown(self) -> None:
        self.box.close()

    def test_verb_routing(self) -> None:
        e = self.engine
        self.assertEqual(e.bin_for(["./app", "bridge", "start"]), os.environ["AGENT_APP_CLI"])
        self.assertEqual(e.bin_for(["list", "--json"]), os.environ["AGENT_APP_CLI"])
        self.assertEqual(e.bin_for(["./app", "tasks", "next"]), os.environ["A2APP_CLI"])
        self.assertEqual(e.bin_for(["./app"]), os.environ["A2APP_CLI"])

    def test_harness_file_rules(self) -> None:
        e, file = self.engine, self.box.home / "harnesses.json"
        profile = {"id": "myharness", "routes": [{"mode": "headless", "command": "mh", "args": ["{prompt}"]}]}
        self.assertEqual(e.register_harness_profile(profile)["status"], "registered")
        edited = {"id": "myharness", "routes": [{"mode": "headless", "command": "/opt/mh", "args": ["{prompt}"]}]}
        file.write_text(json.dumps({"version": 1, "harnesses": [edited]}), encoding="utf-8")
        self.assertEqual(e.register_harness_profile(profile)["status"], "kept")
        self.assertEqual(json.loads(file.read_text(encoding="utf-8"))["harnesses"], [edited], "an existing entry is never overwritten")
        other = {"id": "other", "routes": [{"mode": "subscribe"}]}
        file.write_text(json.dumps({"version": 1, "default": "other", "harnesses": [other]}), encoding="utf-8")
        self.assertEqual(e.register_harness_profile(profile)["status"], "registered")
        self.assertEqual(json.loads(file.read_text(encoding="utf-8")), {"version": 1, "default": "other", "harnesses": [other, profile]})
        for unreadable in ("{ not json", json.dumps({"version": 1, "harnesses": {"id": "x"}}), "[]"):
            file.write_text(unreadable, encoding="utf-8")
            self.assertEqual(e.register_harness_profile(profile)["status"], "refused")
            self.assertEqual(file.read_text(encoding="utf-8"), unreadable, "an unreadable file is left exactly as it was")

    def test_npm_shim_is_run_through_node_not_cmd(self) -> None:
        shim_dir = self.box.dir / "npm"
        script = shim_dir / "node_modules" / "agent-app-framework" / "bin" / "agent-app.js"
        script.parent.mkdir(parents=True)
        script.write_text("", encoding="utf-8")
        shim = shim_dir / "agent-app.cmd"
        shim.write_text('@ECHO off\r\n... "%_prog%"  "%dp0%\\node_modules\\agent-app-framework\\bin\\agent-app.js" %*\r\n', encoding="utf-8")
        resolved = self.engine._resolve_shim(str(shim))
        self.assertEqual(Path(resolved[1]).resolve(), script.resolve())
        pnpm = shim_dir / "pnpm-style.cmd"
        pnpm.write_text('@SETLOCAL\r\n"%~dp0\\node_modules\\agent-app-framework\\bin\\agent-app.js" %*\r\n', encoding="utf-8")
        self.assertEqual(Path(self.engine._resolve_shim(str(pnpm))[1]).resolve(), script.resolve())

    def test_known_apps_parse_is_tolerant(self) -> None:
        e = self.engine
        self.assertEqual(e.parse_known_apps(e.CliResult(0, "not json", "")), [])
        rows = e.parse_known_apps(e.CliResult(0, json.dumps({"apps": [
            {"id": "crm", "name": "CRM", "path": "/a/crm", "port": 8080, "status": "running", "url": "http://127.0.0.1:8080/"},
            {"id": "x"}, {"id": "y", "path": "/a/y", "port": True},
        ]}), ""))
        self.assertEqual(rows, [
            {"id": "crm", "name": "CRM", "path": "/a/crm", "url": "http://127.0.0.1:8080/", "port": 8080, "status": "running"},
            {"id": "y", "name": "y", "path": "/a/y", "url": None},
        ])

    @unittest.skipUnless(STARTER_DIST.exists(), "build @a2app/integration-starter for the parity check")
    def test_argv_and_kickoff_match_the_typescript_engine(self) -> None:
        cases = [
            ["agent_app_describe", {"dir": "crm", "path": ""}],
            ["agent_app_describe", {"dir": "crm", "path": "/sales//invoices/", "all": True}],
            ["agent_app_find", {"dir": "crm", "term": "invoice"}],
            ["agent_app_list", {"dir": "crm", "entity": "deals", "filter": "stage=won", "sort": "-amount", "limit": 5}],
            ["agent_app_get", {"dir": "crm", "entity": "deals", "id": "D1"}],
            ["agent_app_create", {"dir": "crm", "entity": "deals", "fields": {"a": 1, "b": [1, "x"], "c": None, "d": "é & ü"}}],
            ["agent_app_update", {"dir": "crm", "entity": "deals", "id": "D1", "fields": {"t": True}}],
            ["agent_app_delete", {"dir": "crm", "entity": "deals", "id": "D1"}],
            ["agent_app_run_operation", {"dir": "crm", "path": "sales", "operation": "close", "fields": {"n": 2, "ok": False, "s": "x y"}, "approve": "abc"}],
            ["agent_app_poll_tasks", {"dir": "crm"}],
            ["agent_app_poll_tasks", {"dir": "crm", "status": "working"}],
            ["agent_app_next_task", {"dir": "crm", "waitMs": 60000, "capability": "report"}],
            ["agent_app_task_progress", {"dir": "crm", "id": "T1", "step": "half", "percent": 50}],
            ["agent_app_complete_task", {"dir": "crm", "id": "T1", "result": {"summary": "done"}}],
            ["agent_app_complete_task", {"dir": "crm", "id": "T1", "reason": "blocked"}],
            ["agent_app_build", {"dir": "crm"}],
            ["agent_app_validate", {"dir": "crm", "noBuild": True}],
            ["agent_app_serve", {"dir": "crm", "install": True, "open": True}],
            ["agent_app_stop", {"dir": "crm"}],
            ["agent_app_open", {"dir": "crm"}],
        ]
        kickoffs = [
            {"action": "build", "name": "Acme CRM", "requirement": "Track deals.", "blueprint": "blueprint-base", "port": "8123"},
            {"action": "build", "name": "Acme CRM", "requirement": "Track deals."},
            {"action": "build", "name": "", "requirement": "x"},
            {"action": "modify", "dir": "/a/crm", "requirement": "Add a report."},
            {"action": "operate", "dir": "/a/crm", "requirement": "Close won deals."},
            {"action": "nope"},
        ]
        script = self.box.dir / "parity.mjs"
        script.write_text(textwrap.dedent(f"""
            import {{ a2appTools, buildKickoffPrompt }} from {json.dumps(STARTER_DIST.as_uri())};
            const [cases, kickoffs] = JSON.parse(process.argv[2]);
            const tools = a2appTools(process.env.A2APP_CLI, process.env.AGENT_APP_CLI);
            const argv = [];
            for (const [name, args] of cases) {{
              const r = await tools.find((t) => t.name === name).handler(args);
              argv.push(JSON.parse(r.stdout));
            }}
            console.log(JSON.stringify({{ argv, kickoffs: kickoffs.map((k) => {{ const r = buildKickoffPrompt(k); return r.kind === "kickoff" ? r.prompt : r.message; }}) }}));
        """), encoding="utf-8")
        proc = subprocess.run([NODE, str(script), json.dumps([cases, kickoffs])], capture_output=True, text=True, encoding="utf-8", check=True)
        ts = json.loads(proc.stdout)
        tools = {t.name: t for t in self.engine.a2app_tools()}
        py_argv = [json.loads(tools[name].call(args).stdout) for name, args in cases]
        self.assertEqual(py_argv, ts["argv"])
        py_kick = [(lambda r: r["prompt"] if r["kind"] == "kickoff" else r["message"])(self.engine.build_kickoff_prompt(k)) for k in kickoffs]
        self.assertEqual(py_kick, ts["kickoffs"])


try:
    import fastapi  # noqa: F401  (Hermes's dashboard runs on FastAPI)
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    HAVE_FASTAPI = True
except ImportError:
    HAVE_FASTAPI = False


class FakeSessions:
    """Hermes's session store, backed by the fake hermes binary's transcript files."""

    def __init__(self, store: Path) -> None:
        self.store = store
        self.ensured: list[tuple[str, str]] = []
        self.deleted: list[str] = []

    def ensure(self, sid: str, title: str) -> None:
        self.ensured.append((sid, title))

    def messages(self, sid: str) -> list[dict]:
        f = self.store / f"{sid}.jsonl"
        return [json.loads(line) for line in f.read_text(encoding="utf-8").splitlines()] if f.exists() else []

    def delete(self, sid: str) -> None:
        self.deleted.append(sid)
        (self.store / f"{sid}.jsonl").unlink(missing_ok=True)


@unittest.skipIf(NODE is None or not HAVE_FASTAPI, "node and fastapi are required for the dashboard API")
class DashboardApi(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()
        self.store = self.box.dir / "store"
        self.store.mkdir()
        self.hermes_calls = self.box.dir / "hermes-calls.jsonl"
        fake_hermes = self.box.dir / "fake_hermes.py"
        fake_hermes.write_text(FAKE_HERMES, encoding="utf-8")
        os.environ.update({"FAKE_STORE": str(self.store), "FAKE_HERMES_CALLS": str(self.hermes_calls), "HERMES_BIN": str(fake_hermes)})
        # What a desktop or Chat-tab session leaves in the dashboard process.
        os.environ.update({"HERMES_TUI": "1", "HERMES_SESSION_KEY": "leaked", "HERMES_GATEWAY_SESSION": "1", "KEEP_ME": "yes"})
        self.api = load_dashboard_api()
        self.manager = self.api.Manager(self.api.TurnRunner(self.box.dir / "data"), FakeSessions(self.store))
        app = FastAPI()
        app.include_router(self.api.build_router(self.manager), prefix="/api/plugins/agent-app")
        self.client = TestClient(app)
        self.apps_dir = self.box.home / "apps"

    def tearDown(self) -> None:
        self.box.close()

    def wait_idle(self, path: str, timeout: float = 20) -> None:
        sid = self.api.session_id_for(path)
        deadline = time.time() + timeout
        while self.manager.runner.busy(sid):
            if time.time() > deadline:
                self.fail("turn did not finish")
            time.sleep(0.05)

    def turns(self) -> list[dict]:
        if not self.hermes_calls.exists():
            return []
        return [json.loads(line) for line in self.hermes_calls.read_text(encoding="utf-8").splitlines() if line]

    def test_module_mounts_as_the_dashboard_mounts_it(self) -> None:
        app = FastAPI()
        app.include_router(self.api.router, prefix="/api/plugins/agent-app")
        meta = TestClient(app).get("/api/plugins/agent-app/meta").json()
        self.assertTrue(meta["ok"])
        self.assertIn("blueprint-react-node", meta["blueprints"])
        self.assertEqual(meta["build"], "dev")

    def test_build_runs_the_creator_kickoff_in_the_apps_session(self) -> None:
        bad = self.client.post("/api/plugins/agent-app/build", json={"name": "", "requirement": "x"})
        self.assertEqual((bad.status_code, bad.json()["message"]), (400, "Give the app a name."))
        bad = self.client.post("/api/plugins/agent-app/build", json={"name": "Acme CRM"})
        self.assertEqual(bad.status_code, 400)

        os.environ["FAKE_TURN_DELAY"] = "2"  # long enough to observe the build in flight
        r = self.client.post("/api/plugins/agent-app/build", json={"name": "Acme CRM", "requirement": "Track deals.", "blueprint": "blueprint-base", "port": ""})
        self.assertEqual(r.status_code, 200, r.text)
        path = r.json()["path"]
        self.assertEqual(Path(path), self.apps_dir / "acme-crm")
        sid = self.api.session_id_for(path)
        self.assertRegex(sid, r"^agent-app-acme-crm-[0-9a-f]{8}$")

        rows = self.client.get("/api/plugins/agent-app/apps").json()["rows"]
        self.assertEqual([(x["name"], x["building"]) for x in rows], [("Acme CRM", True)])
        again = self.client.post("/api/plugins/agent-app/build", json={"name": "Acme CRM", "requirement": "x"})
        self.assertIn("already being built", again.json()["message"])

        self.wait_idle(path)
        turn = self.turns()[0]
        self.assertEqual(turn["argv"], ["--cli", "chat", "-Q", "--resume", sid, "--source", "tool", "--in", str(self.apps_dir), "--query-file", "-"])
        self.assertEqual(Path(turn["cwd"]).resolve(), self.apps_dir.resolve())
        self.assertIn('Build a new Agent App named "Acme CRM"', turn["message"])
        self.assertIn("**creator** skill", turn["message"])
        self.assertIn(f"Create the app at `{path}`", turn["message"])
        self.assertEqual(turn["env"], {"HERMES_TUI": None, "HERMES_SESSION_KEY": None, "HERMES_GATEWAY_SESSION": None, "KEEP_ME": "yes"})
        self.assertEqual(self.manager.sessions.ensured, [(sid, "Agent App: Acme CRM")])

        session = self.client.get("/api/plugins/agent-app/session", params={"app": path}).json()
        self.assertEqual([m["role"] for m in session["messages"]], ["user", "assistant", "tool", "assistant"])
        self.assertEqual(session["messages"][1]["tools"], ["terminal"])
        self.assertEqual(session["messages"][3]["text"], "Done.")
        self.assertEqual((session["busy"], session["error"]), (False, None))

        rows = self.client.get("/api/plugins/agent-app/apps").json()["rows"]
        self.assertEqual([(x["building"], x["buildEnded"]) for x in rows], [(False, True)], "the build run ended without the app coming up")

        self.box.set_registry([{"id": "acme-crm", "name": "Acme CRM", "path": path, "port": 8123, "status": "running", "url": "http://127.0.0.1:8123/"}])
        rows = self.client.get("/api/plugins/agent-app/apps").json()["rows"]
        self.assertEqual([(x["status"], x["building"], x["buildEnded"]) for x in rows], [("running", False, False)], "a build retires once its app runs")

    def test_messages_queue_in_order_and_the_first_carries_the_preamble(self) -> None:
        app_dir = self.box.dir / "crm"
        app_dir.mkdir()
        self.box.set_registry([{"id": "crm", "name": "CRM", "path": str(app_dir), "status": "stopped"}])
        os.environ["FAKE_TURN_DELAY"] = "0.4"
        for text in ("add a pipeline report", "and a CSV export"):
            r = self.client.post("/api/plugins/agent-app/session/send", json={"path": str(app_dir), "name": "CRM", "text": text})
            self.assertEqual(r.json(), {"ok": True})
        self.assertTrue(self.client.get("/api/plugins/agent-app/session", params={"app": str(app_dir)}).json()["busy"])
        self.wait_idle(str(app_dir))
        first, second = self.turns()
        self.assertTrue(first["message"].startswith('You are working on the Agent App "CRM"'))
        self.assertTrue(first["message"].endswith("add a pipeline report"))
        self.assertEqual(second["message"], "and a CSV export")
        self.assertLessEqual(first["end"], second["start"], "turns on one session never overlap")
        self.assertEqual(Path(first["cwd"]).resolve(), app_dir.resolve())
        self.assertEqual(first["argv"][first["argv"].index("--in") + 1], str(app_dir))

        empty = self.client.post("/api/plugins/agent-app/session/send", json={"path": str(app_dir), "text": "  "})
        self.assertEqual(empty.status_code, 400)

    def test_a_failed_turn_reports_why(self) -> None:
        app_dir = self.box.dir / "crm"
        app_dir.mkdir()
        self.client.post("/api/plugins/agent-app/session/send", json={"path": str(app_dir), "name": "CRM", "text": "FAIL please"})
        self.wait_idle(str(app_dir))
        session = self.client.get("/api/plugins/agent-app/session", params={"app": str(app_dir)}).json()
        self.assertIn("exited with code 1", session["error"])
        self.assertIn("no API key configured", session["error"])
        log = self.box.dir / "data" / "logs" / f"{self.api.session_id_for(str(app_dir))}.log"
        self.assertIn("no API key configured", log.read_text(encoding="utf-8"))

    def test_lifecycle_shells_agent_app(self) -> None:
        app_dir = str(self.box.dir / "crm")
        unknown = self.client.post("/api/plugins/agent-app/app/serve", json={"path": app_dir})
        self.assertEqual(unknown.status_code, 404)
        self.box.set_registry([{"id": "crm", "name": "CRM", "path": app_dir, "status": "stopped"}])
        self.assertEqual(self.client.post("/api/plugins/agent-app/app/serve", json={"path": app_dir}).json(), {"ok": True, "message": ""})
        self.assertEqual(self.box.recorded()[-1]["argv"], [app_dir, "serve"])
        self.assertEqual(self.client.post("/api/plugins/agent-app/app/remove", json={"path": app_dir}).json(), {"ok": True})
        self.assertEqual([c["argv"] for c in self.box.recorded()[-2:]], [[app_dir, "stop"], [app_dir, "remove", "--yes"]])
        self.assertEqual(self.manager.sessions.deleted, [self.api.session_id_for(app_dir)])
        self.assertEqual(self.client.post("/api/plugins/agent-app/app/launch", json={"path": app_dir}).status_code, 404)

    def test_session_ids_are_stable_and_safe(self) -> None:
        sid = self.api.session_id_for
        self.assertEqual(sid("/x/My App!"), sid("/x/My App!/"))
        self.assertNotEqual(sid("/x/crm"), sid("/y/crm"))
        self.assertRegex(sid("/x/Ünïcode app"), r"^agent-app-[A-Za-z0-9_-]+$")

    def test_hermes_is_started_by_the_running_interpreter(self) -> None:
        os.environ.pop("HERMES_BIN", None)
        self.assertEqual(self.api.hermes_argv(), [sys.executable, "-m", "hermes_cli.main"])


@unittest.skipIf(NODE is None, "node is required to syntax-check the page")
class DashboardPage(unittest.TestCase):
    def test_manifest_points_at_real_files(self) -> None:
        manifest = json.loads((PLUGIN / "dashboard" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "agent-app", "must equal plugin.yaml's name: the dashboard gates the tab on it")
        for key in ("entry", "css", "api"):
            self.assertTrue((PLUGIN / "dashboard" / manifest[key]).is_file(), key)

    def test_page_is_a_classic_script_that_registers_the_tab(self) -> None:
        page = PLUGIN / "dashboard" / "manager.js"
        subprocess.run([NODE, "--check", str(page)], check=True)
        probe = textwrap.dedent(f"""
            const registered = [];
            globalThis.window = {{
              __HERMES_PLUGIN_SDK__: {{ React: {{ createElement: () => null }}, hooks: {{}}, fetchJSON: () => Promise.resolve({{}}) }},
              __HERMES_PLUGINS__: {{ register: (name, c) => registered.push([name, typeof c]) }},
            }};
            globalThis.location = {{ protocol: "http:", hostname: "127.0.0.1" }};
            require({json.dumps(str(page))});
            console.log(JSON.stringify(registered));
        """)
        out = subprocess.run([NODE, "-e", probe], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(out.stdout), [["agent-app", "function"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
