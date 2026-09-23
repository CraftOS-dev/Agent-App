# lifecycle.promote — apply a code change to the live database.
#
# For a schema-in-code SQLite store there is no destructive migration chain:
# changes are additive (a new field simply defaults to absent, an existing
# record stays valid). By the time this runs, the framework has ALREADY taken
# the mandatory pre-promote backup. This step therefore:
#   1. confirms the app's Ruby still parses (and the schema still loads),
#   2. confirms the current LIVE database is still readable under the new
#      schema,
#   3. REFUSES the one destructive case — an entity that still holds live
#      data being removed from the schema — so promote can never silently
#      orphan data.
#
# Run via `bundle exec ruby scripts/promote_check.rb` (the sqlite3 gem comes
# from the bundle).
ROOT = File.expand_path("..", __dir__)

# 1. The app must parse (compile only — nothing is executed), and the schema
#    must load: a schema that raises on require would take the boot down.
[
  "lib/a2app_adapter.rb",
  "lib/a2app_schema.rb",
  "app/controllers/a2app_controller.rb",
].each do |rel|
  RubyVM::InstructionSequence.compile_file(File.join(ROOT, rel))
rescue SyntaxError => e
  warn "#{rel} does not parse (#{e.message}) — refusing to promote"
  exit 1
end
require_relative "../lib/a2app_schema"

live = File.join(ROOT, "data", "db.sqlite")

unless File.exist?(live)
  puts "first install — no live database to migrate"
  exit 0
end

# 2. Live must still open and read.
begin
  require "sqlite3"
  db = SQLite3::Database.new(live, readonly: true)
  held = db.execute("SELECT entity, COUNT(*) FROM records GROUP BY entity")
  db.close
rescue StandardError => err
  warn "live database is unreadable (#{err.message}) — refusing to promote"
  exit 1
end

# 3. Refuse to orphan data: an entity that holds live records must still exist
#    in the new schema (removing it is a destructive migration).
declared = A2appSchema::ENTITIES.keys
orphaned = held.select { |entity, count| count > 0 && !declared.include?(entity) }.map(&:first)
unless orphaned.empty?
  plural = orphaned.length == 1 ? "y" : "ies"
  warn "refusing to promote: live data exists for entit#{plural} removed " \
       "from the schema (#{orphaned.join(", ")}). Removing an entity that holds data is destructive — " \
       "migrate or export that data first."
  exit 1
end

live_entities = held.select { |_entity, count| count > 0 }.map(&:first)
puts "live database compatible with the new schema (#{declared.length} declared; " \
     "live data in: #{live_entities.empty? ? "none" : live_entities.join(", ")})"
