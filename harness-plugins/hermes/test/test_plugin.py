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
import contextlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import types
import unittest
import unittest.mock
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
import json, os, re, sys, time
args = sys.argv[1:]
message = sys.stdin.read()
sid = args[args.index("--resume") + 1]
record = {"argv": args, "cwd": os.getcwd(), "message": message, "start": time.time(),
          "env": {k: os.environ.get(k) for k in ("HERMES_TUI", "HERMES_SESSION_KEY", "HERMES_GATEWAY_SESSION", "HERMES_YOLO_MODE", "KEEP_ME")}}
# A message may set its own turn length ("SLEEP=2 ..."); otherwise FAKE_TURN_DELAY.
sleep = re.search(r"SLEEP=([0-9.]+)", message)
time.sleep(float(sleep.group(1) if sleep else os.environ.get("FAKE_TURN_DELAY", "0")))
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


@contextlib.contextmanager
def fake_modules(modules: dict):
    """Install modules in sys.modules for the block (None makes an import fail),
    restoring whatever was there before."""
    saved = {name: sys.modules.get(name, _MISSING) for name in modules}
    sys.modules.update(modules)
    try:
        yield
    finally:
        for name, module in saved.items():
            if module is _MISSING:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


_MISSING = object()


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

    def test_a_relative_dir_resolves_in_the_calling_sessions_directory(self) -> None:
        # A multi-session host keeps each session's directory per session;
        # TERMINAL_CWD then holds some other session's, and must lose.
        session_dir = self.box.dir / "session"
        session_dir.mkdir()
        os.environ["TERMINAL_CWD"] = str(self.box.dir)
        fake = types.ModuleType("agent.runtime_cwd")
        fake.resolve_agent_cwd = lambda: session_dir
        with fake_modules({"agent.runtime_cwd": fake}):
            self.call("agent_app_get", dir=".", entity="deals", id="D1")
        self.assertEqual(Path(self.box.recorded()[-1]["cwd"]).resolve(), session_dir.resolve())

    def test_without_runtime_cwd_a_relative_dir_resolves_in_the_terminal(self) -> None:
        os.environ["TERMINAL_CWD"] = str(self.box.dir)
        with fake_modules({"agent.runtime_cwd": None}):  # a Hermes that predates it
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
        # The prompt goes in on stdin (no OS cap on its size), so no argument carries it.
        self.assertEqual(route["input"], "stdin")
        self.assertEqual(route["args"][-2:], ["--query-file", "-"])
        self.assertNotIn("{prompt}", " ".join(route["args"]))


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
        os.environ.update({"HERMES_TUI": "1", "HERMES_SESSION_KEY": "leaked", "HERMES_GATEWAY_SESSION": "1", "HERMES_YOLO_MODE": "1", "KEEP_ME": "yes"})
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
        self.assertEqual(turn["env"], {"HERMES_TUI": None, "HERMES_SESSION_KEY": None, "HERMES_GATEWAY_SESSION": None, "HERMES_YOLO_MODE": None, "KEEP_ME": "yes"})
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

    def test_a_cancelled_session_never_runs_two_turns_at_once(self) -> None:
        # The killed turn's thread is slow to notice (as a Hermes that handles
        # SIGTERM gracefully would be); new work sent meanwhile must still run
        # one turn at a time.
        app_dir = self.box.dir / "crm"
        app_dir.mkdir()
        runner, sid = self.manager.runner, self.api.session_id_for(str(app_dir))
        real_turn = runner._turn

        def slow_to_return(sid_, state, message, cwd):
            ok = real_turn(sid_, state, message, cwd)
            if message.startswith("SLEEP=30"):
                time.sleep(0.8)
            return ok

        runner._turn = slow_to_return
        runner.submit(sid, "SLEEP=30 A", str(app_dir))
        deadline = time.time() + 10
        while runner._sessions.get(sid) is None or runner._sessions[sid].proc is None:
            self.assertLess(time.time(), deadline, "the first turn never started")
            time.sleep(0.05)
        runner.cancel(sid)
        runner.submit(sid, "SLEEP=1 B", str(app_dir))
        runner.submit(sid, "SLEEP=1 C", str(app_dir))
        time.sleep(1.2)
        self.wait_idle(str(app_dir))
        turns = {t["message"].split()[1]: t for t in self.turns()}
        self.assertEqual(sorted(turns), ["B", "C"], "the cancelled turn was stopped; both new ones ran")
        self.assertLessEqual(turns["B"]["end"], turns["C"]["start"], "turns on one session never overlap")

    def test_turns_do_not_inherit_the_hosts_session_or_approval_state(self) -> None:
        env = self.api.turn_env({
            "HERMES_YOLO_MODE": "1", "HERMES_SESSION_KEY": "k", "HERMES_UI_SESSION_ID": "u",
            "HERMES_CRON_SESSION": "1", "HERMES_BROWSER_CONTROL_PRINCIPAL": "p",
            "HERMES_DELEGATED_CHILD_CONTEXT": "1", "HERMES_GATEWAY_SESSION": "1", "HERMES_EXEC_ASK": "1",
            "HERMES_HOME": "/h", "KEEP_ME": "yes",
        })
        self.assertEqual(env, {"HERMES_HOME": "/h", "KEEP_ME": "yes"})

    def test_delete_stops_the_turn_before_removing_the_app(self) -> None:
        app_dir = self.box.dir / "crm"
        app_dir.mkdir()
        self.box.set_registry([{"id": "crm", "name": "CRM", "path": str(app_dir), "status": "stopped"}])
        sid = self.api.session_id_for(str(app_dir))
        self.client.post("/api/plugins/agent-app/session/send", json={"path": str(app_dir), "name": "CRM", "text": "SLEEP=60 evolve it"})
        deadline = time.time() + 10
        while self.manager.runner._sessions.get(sid) is None or self.manager.runner._sessions[sid].proc is None:
            self.assertLess(time.time(), deadline, "the turn never started")
            time.sleep(0.05)
        proc = self.manager.runner._sessions[sid].proc
        started = time.time()
        r = self.client.post("/api/plugins/agent-app/app/remove", json={"path": str(app_dir)})
        self.assertEqual(r.json(), {"ok": True})
        self.assertLess(time.time() - started, 30)
        self.assertIsNotNone(proc.poll(), "the agent's turn is gone before the app is removed")
        self.assertEqual([c["argv"] for c in self.box.recorded()[-2:]], [[str(app_dir), "stop"], [str(app_dir), "remove", "--yes"]])
        self.assertFalse(self.manager.runner.busy(sid))

    def test_deleting_a_build_before_it_registers_clears_its_directory(self) -> None:
        os.environ["FAKE_TURN_DELAY"] = "60"
        r = self.client.post("/api/plugins/agent-app/build", json={"name": "Acme CRM", "requirement": "Track deals."})
        path = Path(r.json()["path"])
        path.mkdir(parents=True)  # what the agent's scaffold step would have written
        (path / "package.json").write_text("{}", encoding="utf-8")
        r = self.client.post("/api/plugins/agent-app/app/remove", json={"path": str(path)})
        self.assertEqual(r.json(), {"ok": True})
        self.assertFalse(path.exists(), "a partial build would refuse a rebuild under the same name")
        self.assertEqual(self.client.get("/api/plugins/agent-app/apps").json()["rows"], [])
        os.environ["FAKE_TURN_DELAY"] = "0"
        again = self.client.post("/api/plugins/agent-app/build", json={"name": "Acme CRM", "requirement": "Track deals."})
        self.assertEqual(again.status_code, 200, again.text)
        self.wait_idle(str(path))

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

    def test_inside_hermes_venv_hermes_is_started_by_the_running_interpreter(self) -> None:
        os.environ.pop("HERMES_BIN", None)
        with unittest.mock.patch.object(sys, "base_prefix", sys.prefix + "-base"):
            self.assertEqual(self.api.hermes_argv(), [sys.executable, "-m", "hermes_cli.main"])

    def test_a_host_without_hermes_venv_starts_the_hermes_launcher(self) -> None:
        # hermes-webui imports Hermes into a bare interpreter, which cannot run
        # `-m hermes_cli.main` in a child.
        os.environ.pop("HERMES_BIN", None)
        bindir = self.box.dir / "bin"
        bindir.mkdir()
        launcher = bindir / ("hermes.exe" if os.name == "nt" else "hermes")
        launcher.write_text("", encoding="utf-8")
        launcher.chmod(0o755)
        os.environ["PATH"] = str(bindir)
        with unittest.mock.patch.object(sys, "base_prefix", sys.prefix):
            self.assertEqual(Path(self.api.hermes_argv()[0]).resolve(), launcher.resolve())


def load_module(name: str, path: Path):
    sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class WebuiBackend(unittest.TestCase):
    """The loopback backend the plugin starts inside hermes-webui."""

    TOKEN = "t" * 43

    def setUp(self) -> None:
        self.mod = load_module("agent_app_webui_backend_under_test", PLUGIN / "webui_backend.py")
        self.calls: list[tuple] = []

        def dispatch(method, path, query, body):
            self.calls.append((method, path, query, body))
            return 200, {"ok": True, "path": path}

        self.backend = self.mod.Backend(dispatch, self.TOKEN, self.mod.allowed_origins({"HERMES_WEBUI_PORT": "8787"}))
        self.port = self.backend.server.server_address[1]

    def tearDown(self) -> None:
        self.backend.stop()

    def request(self, method: str, path: str, *, origin: str | None = "http://127.0.0.1:8787", token: str | None = TOKEN,
                host: str | None = None, body: bytes | None = None) -> tuple[int, dict, dict]:
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Host": host or f"127.0.0.1:{self.port}"}
        if origin is not None:
            headers["Origin"] = origin
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=body, headers=headers)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, {k.lower(): v for k, v in res.getheaders()}, (json.loads(raw) if raw else {})

    def test_serves_the_tab_routes_to_the_web_uis_origin(self) -> None:
        status, headers, payload = self.request("GET", "/api/plugins/agent-app/apps")
        self.assertEqual((status, payload), (200, {"ok": True, "path": "/apps"}))
        self.assertEqual(headers["access-control-allow-origin"], "http://127.0.0.1:8787")
        status, _, _ = self.request("POST", "/api/plugins/agent-app/build", body=b'{"name": "CRM"}')
        self.assertEqual(status, 200)
        self.assertEqual(self.calls[-1], ("POST", "/build", "", {"name": "CRM"}))
        self.request("GET", "/api/plugins/agent-app/session?app=%2Fa%2Fcrm")
        self.assertEqual(self.calls[-1][:3], ("GET", "/session", "app=%2Fa%2Fcrm"))

    def test_a_local_tool_without_an_origin_still_needs_the_token(self) -> None:
        self.assertEqual(self.request("GET", "/api/plugins/agent-app/meta", origin=None)[0], 200)
        self.assertEqual(self.request("GET", "/api/plugins/agent-app/meta", origin=None, token=None)[0], 401)

    def test_refuses_a_wrong_token_another_origin_and_a_rebinding_host(self) -> None:
        status, headers, _ = self.request("GET", "/api/plugins/agent-app/apps", token="nope")
        self.assertEqual(status, 401)
        self.assertIn("access-control-allow-origin", headers, "the page can read a 401 and re-read runtime.json")
        status, headers, _ = self.request("GET", "/api/plugins/agent-app/apps", origin="https://evil.example")
        self.assertEqual(status, 403)
        self.assertNotIn("access-control-allow-origin", headers)
        self.assertEqual(self.request("GET", "/api/plugins/agent-app/apps", host=f"evil.example:{self.port}")[0], 403)
        self.assertEqual(self.calls, [], "nothing refused reached the manager")

    def test_preflight_is_answered_only_for_the_web_ui(self) -> None:
        status, headers, _ = self.request("OPTIONS", "/api/plugins/agent-app/build", token=None)
        self.assertEqual(status, 204)
        self.assertIn("Authorization", headers["access-control-allow-headers"])
        self.assertEqual(self.request("OPTIONS", "/api/plugins/agent-app/build", token=None, origin="https://evil.example")[0], 403)

    def test_rejects_a_body_that_is_not_json_and_paths_outside_the_api(self) -> None:
        self.assertEqual(self.request("POST", "/api/plugins/agent-app/build", body=b"{nope")[0], 400)
        self.assertEqual(self.request("GET", "/etc/passwd")[0], 404)

    def test_starts_only_in_the_web_ui_server(self) -> None:
        checkout = Path(tempfile.mkdtemp(prefix="webui-"))
        try:
            (checkout / "api").mkdir()
            (checkout / "api" / "extensions.py").write_text("", encoding="utf-8")
            (checkout / "server.py").write_text("", encoding="utf-8")
            self.assertTrue(self.mod.in_webui_server([str(checkout / "server.py")]))
            self.assertFalse(self.mod.in_webui_server(["/usr/bin/hermes", "--cli", "chat"]))
            self.assertFalse(self.mod.in_webui_server([str(PLUGIN / "server.py")]), "some other server.py")
            with unittest.mock.patch.dict(os.environ, {"AGENT_APP_WEBUI_BACKEND": "0"}):
                self.assertFalse(self.mod.in_webui_server([str(checkout / "server.py")]))
        finally:
            shutil.rmtree(checkout, ignore_errors=True)


@unittest.skipIf(NODE is None, "node is required for the fake framework CLIs")
class WebuiStart(unittest.TestCase):
    """maybe_start() end to end: the real Manager behind the real backend."""

    def setUp(self) -> None:
        self.box = Sandbox()
        self.state = self.box.dir / "webui-state"
        (self.state / "extensions" / "agent-app").mkdir(parents=True)
        (self.state / "extensions" / "agent-app" / "manifest.json").write_text("{}", encoding="utf-8")
        self.checkout = self.box.dir / "hermes-webui"
        (self.checkout / "api").mkdir(parents=True)
        (self.checkout / "api" / "extensions.py").write_text("", encoding="utf-8")
        (self.checkout / "server.py").write_text("", encoding="utf-8")
        os.environ.update({"HERMES_WEBUI_STATE_DIR": str(self.state), "HERMES_WEBUI_PORT": "8787", "HERMES_HOME": str(self.box.dir / "hermes-home")})
        os.environ.pop("HERMES_WEBUI_EXTENSION_DIR", None)
        self.mod = load_module("agent_app_webui_backend_start", PLUGIN / "webui_backend.py")

    def tearDown(self) -> None:
        holder = sys.modules.pop(self.mod._HOLDER, None)
        if holder is not None:
            holder.backend.stop()
        sys.modules.pop("hermes_agent_app_plugin_api", None)
        self.box.close()

    def test_publishes_the_backend_to_the_extension_and_serves_the_manager(self) -> None:
        import urllib.request

        with fake_modules({"api.extensions": None}):  # not inside a real web UI: resolve the managed dir itself
            with unittest.mock.patch.object(sys, "argv", [str(self.checkout / "server.py")]):
                info = self.mod.maybe_start()
                self.assertIs(self.mod.maybe_start(), info, "a second load reuses the running backend")
        runtime = json.loads((self.state / "extensions" / "agent-app" / "runtime.json").read_text(encoding="utf-8"))
        self.assertEqual(runtime["base"], info["base"])
        self.assertGreaterEqual(len(runtime["token"]), 32)
        req = urllib.request.Request(runtime["base"] + "/api/plugins/agent-app/meta", headers={"Authorization": "Bearer " + runtime["token"]})
        with urllib.request.urlopen(req, timeout=10) as res:
            meta = json.loads(res.read())
        self.assertTrue(meta["ok"])
        self.assertIn("blueprint-react-node", meta["blueprints"])
        self.assertEqual(Path(meta["appsDir"]).resolve(), (self.box.home / "apps").resolve())

    def test_register_never_waits_for_the_backend(self) -> None:
        # The web UI loads plugins midway through its own imports and gives
        # register() 10s; a backend start that blocks (an import waiting on
        # the web UI) must not hold the plugin load.
        plugin = load_plugin()
        release = threading.Event()
        started = threading.Event()

        def blocked_start():
            started.set()
            release.wait(30)
            return None

        try:
            with unittest.mock.patch.object(sys, "argv", [str(self.checkout / "server.py")]), \
                    unittest.mock.patch.object(plugin.webui_backend, "maybe_start", blocked_start):
                t = time.time()
                plugin.register(FakeContext())
                self.assertLess(time.time() - t, 5, "register() returned while the backend was still starting")
                self.assertTrue(started.wait(10), "the backend start ran on its own thread")
        finally:
            release.set()

    def test_does_nothing_without_the_extension(self) -> None:
        shutil.rmtree(self.state / "extensions")
        with fake_modules({"api.extensions": None}), unittest.mock.patch.object(sys, "argv", [str(self.checkout / "server.py")]):
            self.assertIsNone(self.mod.maybe_start())


class WebuiInstall(unittest.TestCase):
    def test_installs_beside_other_extensions_and_records_itself(self) -> None:
        build = load_module("agent_app_build_under_test", PLUGIN / "scripts" / "build.py")
        tmp = Path(tempfile.mkdtemp(prefix="aa-build-"))
        try:
            build.DIST = tmp / "dist"
            build.stage()
            state = tmp / "webui"
            state.mkdir()
            other = {"version": "1.2.0", "files": ["app.js"], "installed_at": "2026-01-01T00:00:00Z"}
            (state / "extension-install-manifest.json").write_text(json.dumps({"version": 1, "installed": {"other": other}}), encoding="utf-8")
            target = build.install_webui(state)
            self.assertEqual(sorted(p.name for p in target.iterdir()), sorted(build.WEBUI_FILES))
            record = json.loads((state / "extension-install-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(record["installed"]["other"], other, "another extension's record is kept")
            mine = record["installed"]["agent-app"]
            self.assertIn("runtime.json", mine["files"], "the web UI's Uninstall removes the runtime file too")
            manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["scripts"], ["manager.js", "agent-apps.js"], "the manager loads before the glue")
            self.assertEqual((target / "manager.js").read_text(encoding="utf-8"), (PLUGIN / "dashboard" / "manager.js").read_text(encoding="utf-8"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


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

    def test_without_the_dashboard_sdk_the_page_offers_mount_for_another_host(self) -> None:
        page = PLUGIN / "dashboard" / "manager.js"
        glue = PLUGIN / "webui" / "agent-apps.js"
        subprocess.run([NODE, "--check", str(glue)], check=True)
        probe = textwrap.dedent(f"""
            globalThis.window = {{}};
            globalThis.location = {{ protocol: "http:", hostname: "127.0.0.1" }};
            require({json.dumps(str(page))});
            console.log(typeof window.__AGENT_APP_MANAGER__.mount);
        """)
        out = subprocess.run([NODE, "-e", probe], capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), "function")


if __name__ == "__main__":
    unittest.main(verbosity=2)
