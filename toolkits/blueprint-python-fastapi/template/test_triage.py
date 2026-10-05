"""Starter regression: run through the adapter, not just the runner."""
import copy
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

import schema
from a2app_adapter import Adapter, Store


def fixture():
    store = Store(schema.SEED)
    adapter = Adapter(app_id="triage-test", app_name="test", entities=schema.ENTITIES,
                      operations=schema.OPERATIONS, store=store, token="test",
                      modules=[{"name": "planning"}], operation_runners=schema.OPERATION_RUNNERS,
                      events=schema.EVENTS)
    return adapter, store


def ask(adapter):
    return adapter.dispatch("POST", "/api/ops/request-triage", {"x-a2app-token": "test"}, {"task": "task_welcome"})


class TriageTest(unittest.TestCase):
    def test_states(self):
        for state in ("submitted", "working", "input-required", "completed", "failed", "canceled"):
            with self.subTest(state=state):
                adapter, store = fixture()
                status, body = ask(adapter)
                self.assertEqual(status, 200)
                previous = body["result"]["queued"]
                task = store.get_task(previous)
                task["status"] = state
                store.save_task(task)
                before = copy.deepcopy(store.get_record("tasks", "task_welcome"))
                event_count = len(store.events)
                status, body = ask(adapter)
                if state in ("submitted", "working", "input-required"):
                    self.assertEqual((status, body["code"], body["taskId"]), (409, "already_queued", previous))
                    self.assertEqual(len(store.tasks), 1)
                    self.assertEqual(len(store.events), event_count)
                    self.assertEqual(store.get_record("tasks", "task_welcome"), before)
                else:
                    self.assertEqual(status, 200)
                    new_id = body["result"]["queued"]
                    self.assertNotEqual(new_id, previous)
                    self.assertEqual(store.get_task(new_id)["request"]["payload"]["previous"], previous)

    def test_concurrent_requests(self):
        adapter, store = fixture()
        trigger = store.trigger
        def delayed(*args, **kwargs):
            time.sleep(0.02)  # release the GIL between reading the record and enqueueing
            return trigger(*args, **kwargs)
        store.trigger = delayed
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(lambda _: ask(adapter), range(2)))
        self.assertEqual(sorted(r[0] for r in replies), [200, 409])
        self.assertEqual(len(store.tasks), 1)
        self.assertEqual(len(store.events), 1)

    def test_unavailable_queue(self):
        adapter, store = fixture()
        record = store.get_record("tasks", "task_welcome")
        record["agentTask"] = "missing"
        store.put_record("tasks", record)
        status, body = ask(adapter)
        self.assertEqual((status, body["code"], body["taskId"]), (409, "agent_task_unavailable", "missing"))
        def failed_read(_id):
            raise RuntimeError("queue read failed")
        store.get_task = failed_read
        status, body = ask(adapter)
        self.assertEqual((status, body["code"]), (500, "operation_failed"))
        self.assertEqual((len(store.tasks), len(store.events)), (0, 0))


if __name__ == "__main__":
    unittest.main()
