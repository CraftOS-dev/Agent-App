// The Go server + native A2App adapter. modernc.org/sqlite is the one
// dependency: a pure-Go SQLite driver, so the stack builds without cgo or a
// C toolchain. The View's build tooling lives in package.json — npm never
// touches the server, and go never touches the View.
module go-react-agent-app

go 1.22

require modernc.org/sqlite v1.34.5

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v0.1.9 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/sys v0.22.0 // indirect
	modernc.org/libc v1.55.3 // indirect
	modernc.org/mathutil v1.6.0 // indirect
	modernc.org/memory v1.8.0 // indirect
)
