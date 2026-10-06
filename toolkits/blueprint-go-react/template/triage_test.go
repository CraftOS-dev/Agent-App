package main

import (
	"encoding/json"
	"reflect"
	"sync"
	"testing"
)

func triageFixture(t *testing.T) (*Adapter, *Store) {
	t.Helper()
	store := NewStore(SEED)
	app, err := NewAdapter(AdapterConfig{AppID: "triage-test", Entities: ENTITIES, Operations: OPERATIONS,
		Store: store, Token: "test", Modules: []M{{"name": "planning"}}, Runners: OPERATION_RUNNERS, Events: EVENTS})
	if err != nil {
		t.Fatal(err)
	}
	return app, store
}

func askTriage(app *Adapter) (int, M) {
	return app.dispatch("POST", "/api/ops/request-triage", map[string]string{"x-a2app-token": "test"}, M{"task": "task_welcome"}, nil)
}

func TestTriageStates(t *testing.T) {
	for _, state := range []string{"submitted", "working", "input-required", "completed", "failed", "canceled"} {
		t.Run(state, func(t *testing.T) {
			app, store := triageFixture(t)
			status, body := askTriage(app)
			if status != 200 {
				t.Fatal(status, body)
			}
			previous := getStr(body["result"].(M), "queued")
			task := store.getTask(previous)
			task["status"] = state
			store.saveTask(task)
			before, _ := json.Marshal(store.getRecord("tasks", "task_welcome"))
			eventCount := len(toMList(store.eventsSince("")["events"]))
			status, body = askTriage(app)
			switch state {
			case "completed", "failed", "canceled":
				if status != 200 {
					t.Fatal(status, body)
				}
				newID := getStr(body["result"].(M), "queued")
				payload := store.getTask(newID)["request"].(M)["payload"].(M)
				if newID == previous || getStr(payload, "previous") != previous {
					t.Fatal("retry lost occurrence", payload)
				}
			default:
				if status != 409 || getStr(body, "code") != "already_queued" || getStr(body, "taskId") != previous {
					t.Fatal(status, body)
				}
				after, _ := json.Marshal(store.getRecord("tasks", "task_welcome"))
				if string(before) != string(after) || len(store.listTasks("")) != 1 || len(toMList(store.eventsSince("")["events"])) != eventCount {
					t.Fatal("refusal wrote state")
				}
			}
		})
	}
}

func TestTriageConcurrent(t *testing.T) {
	app, store := triageFixture(t)
	var wg sync.WaitGroup
	results := make(chan int, 2)
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; status, _ := askTriage(app); results <- status }()
	}
	close(start)
	wg.Wait()
	counts := map[int]int{}
	counts[<-results]++
	counts[<-results]++
	if !reflect.DeepEqual(counts, map[int]int{200: 1, 409: 1}) || len(store.listTasks("")) != 1 {
		t.Fatal(counts)
	}
}

func TestTriageUnavailableAndFailure(t *testing.T) {
	app, store := triageFixture(t)
	record := store.getRecord("tasks", "task_welcome")
	record["agentTask"] = "missing"
	store.putRecord("tasks", record)
	status, body := askTriage(app)
	if status != 409 || getStr(body, "code") != "agent_task_unavailable" || getStr(body, "taskId") != "missing" {
		t.Fatal(status, body)
	}
	if len(store.listTasks("")) != 0 || len(toMList(store.eventsSince("")["events"])) != 0 {
		t.Fatal("refusal queued work")
	}
	app.runners = map[string]OperationRunner{"request-triage": func(M, M, *Store) (any, error) { panic("ordinary failure") }}
	status, body = askTriage(app)
	if status != 500 || getStr(body, "code") != "operation_failed" {
		t.Fatal(status, body)
	}
}
