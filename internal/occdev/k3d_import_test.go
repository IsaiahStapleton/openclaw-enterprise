package occdev

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The stderr k3d v5.8.3 printed when it closed its stream into the node
// before ctr read it (First Agent Smoke, 2026-10-05 and 2026-10-06).
const k3dClosedStreamOutput = `ERRO[0000] Failed to copy read stream. write unix @->/run/docker.sock: use of closed network connection
ERRO[0000] Failed to import image(s) into cluster 'occ-dev-first-agent-smoke': could not load image to cluster from stream /tmp/development-import.tar: error loading image to cluster, first error: failed to copy read stream. io: read/write on closed pipe
WARN[0000] At least one error occured while trying to import the image(s) into the selected cluster(s)`

// fakeK3dImport puts a k3d on PATH that records each call and fails the first
// `failures` imports with `output` on stderr.
func fakeK3dImport(t *testing.T, failures int, output string) string {
	t.Helper()
	directory := t.TempDir()
	calls := filepath.Join(directory, "calls")
	if err := os.WriteFile(filepath.Join(directory, "failure-output"), []byte(output+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	body := `#!/bin/sh
directory=$(dirname "$0")
echo "$*" >> "$directory/calls"
count=$(wc -l < "$directory/calls")
if [ "$count" -le ` + strconv.Itoa(failures) + ` ]; then
  cat "$directory/failure-output" >&2
  exit 1
fi
exit 0
`
	if err := os.WriteFile(filepath.Join(directory, "k3d"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	return calls
}

func importCalls(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

func TestImportArchiveDirectRetriesAClosedStream(t *testing.T) {
	calls := fakeK3dImport(t, 2, k3dClosedStreamOutput)
	var stderr bytes.Buffer
	r := &runner{opts: Options{Out: &bytes.Buffer{}, Err: &stderr}, env: map[string]string{"PATH": os.Getenv("PATH")}}

	if err := r.importArchiveDirect(context.Background(), "/tmp/development-import.tar", "occ-dev-1"); err != nil {
		t.Fatalf("a closed import stream was not retried: %v", err)
	}
	got := importCalls(t, calls)
	if len(got) != 3 {
		t.Fatalf("expected 3 imports, got %d: %q", len(got), got)
	}
	for _, call := range got {
		if call != "image import --mode direct /tmp/development-import.tar -c occ-dev-1" {
			t.Fatalf("unexpected k3d call: %q", call)
		}
	}
	if !strings.Contains(stderr.String(), "read/write on closed pipe") ||
		!strings.Contains(stderr.String(), "retrying (attempt 3 of 3)") {
		t.Fatalf("k3d output or the retry notice was hidden: %q", stderr.String())
	}
}

func TestImportArchiveDirectStopsAfterTheAttemptBound(t *testing.T) {
	calls := fakeK3dImport(t, 9, k3dClosedStreamOutput)
	r := &runner{opts: Options{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, env: map[string]string{"PATH": os.Getenv("PATH")}}

	err := r.importArchiveDirect(context.Background(), "/tmp/development-import.tar", "occ-dev-1")
	if err == nil || !strings.HasPrefix(err.Error(), "k3d failed: ") {
		t.Fatalf("expected the last k3d failure, got %v", err)
	}
	if got := importCalls(t, calls); len(got) != k3dDirectImportAttempts {
		t.Fatalf("expected %d imports, got %d", k3dDirectImportAttempts, len(got))
	}
}

func TestImportArchiveDirectDoesNotRetryOtherFailures(t *testing.T) {
	for name, output := range map[string]string{
		"missing archive":    "ERRO[0000] Failed to import image(s) into cluster 'occ-dev-1': open /tmp/development-import.tar: no such file or directory",
		"ctr refused":        "ERRO[0000] failed to import images in node 'k3d-occ-dev-1-server-0': Exec process in node 'k3d-occ-dev-1-server-0' failed with exit code '1'",
		"pipe without copy":  "ERRO[0000] something else: io: read/write on closed pipe",
		"copy without close": "ERRO[0000] failed to copy read stream. no space left on device",
	} {
		t.Run(name, func(t *testing.T) {
			calls := fakeK3dImport(t, 9, output)
			r := &runner{opts: Options{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, env: map[string]string{"PATH": os.Getenv("PATH")}}

			if err := r.importArchiveDirect(context.Background(), "/tmp/development-import.tar", "occ-dev-1"); err == nil {
				t.Fatal("a failed import was reported as success")
			}
			if got := importCalls(t, calls); len(got) != 1 {
				t.Fatalf("a non-stream failure was retried: %d imports", len(got))
			}
		})
	}
}

func TestImportArchiveDirectDoesNotRetryACanceledContext(t *testing.T) {
	calls := fakeK3dImport(t, 9, k3dClosedStreamOutput)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &runner{opts: Options{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}, env: map[string]string{"PATH": os.Getenv("PATH")}}

	if err := r.importArchiveDirect(ctx, "/tmp/development-import.tar", "occ-dev-1"); err == nil {
		t.Fatal("a canceled import was reported as success")
	}
	if got := importCalls(t, calls); len(got) > 1 {
		t.Fatalf("a canceled import was retried: %d imports", len(got))
	}
}
