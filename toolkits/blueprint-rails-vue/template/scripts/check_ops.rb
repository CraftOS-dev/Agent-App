# Gate step "operations resolve": every operation declared in
# A2appSchema::OPERATIONS must have a runner in OPERATION_RUNNERS. A declared
# operation with no implementation would describe capability the app cannot
# deliver — the walk shows it, the invoke 501s. A script file rather than a
# shell one-liner so the same gate line survives cmd.exe and POSIX sh.
require_relative "../lib/a2app_schema"

missing = A2appSchema::OPERATIONS
  .reject { |o| A2appSchema::OPERATION_RUNNERS.key?(o["name"]) }
  .map { |o| o["name"] }

if missing.empty?
  puts "operations resolve ok"
else
  abort("declared with no runner: " + missing.join(", "))
end
