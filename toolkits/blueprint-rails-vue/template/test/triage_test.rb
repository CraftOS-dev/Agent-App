require_relative "../lib/a2app_adapter"
require_relative "../lib/a2app_schema"

def fixture
  store = A2appAdapter::Store.new(A2appSchema::SEED)
  app = A2appAdapter::Adapter.new(app_id: "test", app_name: "test", entities: A2appSchema::ENTITIES,
    operations: A2appSchema::OPERATIONS, store: store, token: "test", modules: [{ "name" => "planning" }],
    operation_runners: A2appSchema::OPERATION_RUNNERS, events: A2appSchema::EVENTS)
  [app, store]
end

def ask(app)
  app.dispatch("POST", "/api/ops/request-triage", { "x-a2app-token" => "test" }, { "task" => "task_welcome" }, {})
end

%w[submitted working input-required completed failed canceled].each do |state|
  app, store = fixture
  status, body = ask(app)
  raise "initial request: #{body}" unless status == 200
  previous = body["result"]["queued"]
  task = store.get_task(previous)
  task["status"] = state
  store.save_task(task)
  before = JSON.generate(store.get_record("tasks", "task_welcome"))
  events = store.events_since(nil)["events"].length
  status, body = ask(app)
  if %w[completed failed canceled].include?(state)
    raise "retry: #{body}" unless status == 200
    id = body["result"]["queued"]
    raise "retry occurrence" unless id != previous && store.get_task(id)["request"]["payload"]["previous"] == previous
  else
    raise "refusal: #{body}" unless status == 409 && body["code"] == "already_queued" && body["taskId"] == previous
    raise "refusal wrote state" unless store.list_tasks(nil).length == 1 && store.events_since(nil)["events"].length == events && JSON.generate(store.get_record("tasks", "task_welcome")) == before
  end
end

app, store = fixture
record = store.get_record("tasks", "task_welcome")
record["agentTask"] = "missing"
store.put_record("tasks", record)
status, body = ask(app)
raise "missing task: #{body}" unless status == 409 && body["code"] == "agent_task_unavailable" && body["taskId"] == "missing"
raise "missing task queued work" unless store.list_tasks(nil).empty? && store.events_since(nil)["events"].empty?
def store.get_task(_id)
  raise "queue read failed"
end
status, body = ask(app)
raise "ordinary failure: #{body}" unless status == 500 && body["code"] == "operation_failed"

app, store = fixture
class << store
  alias original_trigger trigger
  def trigger(*args)
    sleep 0.02
    original_trigger(*args)
  end
end
replies = 2.times.map { Thread.new { ask(app) } }.map(&:value)
raise "concurrent requests" unless replies.map(&:first).sort == [200, 409] && store.list_tasks(nil).length == 1
puts "triage test: refusal, terminal retries, no side effects, concurrent requests pass"
