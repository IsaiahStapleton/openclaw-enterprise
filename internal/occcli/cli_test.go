package occcli

import (
	"cmp"
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
)

func TestResourceRequestStopsWhenCommandContextIsCanceled(t *testing.T) {
	requestStarted := make(chan struct{}, 1)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		requestStarted <- struct{}{}
		select {
		case <-request.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)

	keyFile := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	command := New(io.Discard, io.Discard)
	command.SetArgs([]string{
		"installation", "get",
		"--url", server.URL,
		"--service-key-file", keyFile,
		"--timeout-seconds", "30",
	})

	result := make(chan error, 1)
	go func() { result <- command.ExecuteContext(ctx) }()

	select {
	case <-requestStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("request never reached the server")
	}
	cancel()

	select {
	case err := <-result:
		if err == nil {
			t.Fatal("expected a canceled request to fail")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("command ignored context cancellation and kept waiting on the request")
	}
}

type runtimeLogStub struct {
	t        *testing.T
	queries  []url.Values
	pages    []func(http.ResponseWriter, url.Values)
	activeID string
	// revisions is the JSON revision list; empty means the Agent has none.
	revisions string
	paths     []string
}

func (stub *runtimeLogStub) serve(response http.ResponseWriter, request *http.Request) {
	stub.paths = append(stub.paths, request.URL.Path)
	switch {
	case request.URL.Path == "/namespaces/ns_1/agents/agt_1":
		fmt.Fprintf(response, `{"data":{"id":"agt_1","activeRevisionId":%q},"meta":{}}`, stub.activeID)
	case request.URL.Path == "/namespaces/ns_1/agents/agt_1/revisions":
		fmt.Fprintf(response, `{"data":%s,"meta":{}}`, cmp.Or(stub.revisions, "[]"))
	case strings.HasSuffix(request.URL.Path, "/runtime/logs"):
		if request.Header.Get("x-api-key") != "test-key" {
			stub.t.Errorf("missing service key")
		}
		query := request.URL.Query()
		stub.queries = append(stub.queries, query)
		if len(stub.pages) == 0 {
			stub.t.Errorf("unexpected log request %s", request.URL)
			response.WriteHeader(http.StatusInternalServerError)
			return
		}
		next := stub.pages[0]
		stub.pages = stub.pages[1:]
		next(response, query)
	case strings.HasSuffix(request.URL.Path, "/runtime"):
		fmt.Fprint(response, `{"data":{"revisionId":"rev_1","observedAt":"2026-09-30T12:00:00.000Z","pods":[{"role":"gateway","cluster":"control","name":"gw-0","uid":"u","phase":"Running","ready":true,"createdAt":null,"containers":[{"name":"gateway","state":"running","reason":null,"ready":true,"restartCount":2,"startedAt":null,"lastTermination":{"reason":"OOMKilled","exitCode":137,"finishedAt":null}}],"events":[]}],"sources":[{"id":"gateway","kind":"container","pods":[],"available":true,"retention":"current and previous instance"}]},"meta":{}}`)
	default:
		stub.t.Errorf("unexpected request %s", request.URL)
		response.WriteHeader(http.StatusNotFound)
	}
}

func logPage(cursor string, records ...string) func(http.ResponseWriter, url.Values) {
	return func(response http.ResponseWriter, _ url.Values) {
		fmt.Fprintf(
			response,
			`{"data":{"revisionId":"rev_1","source":"gateway","stream":{"source":"gateway","pod":"gw-0"},"observedAt":"2026-09-30T12:00:00.000Z","records":[%s],"withheld":0,"truncated":false,"cursor":%q},"meta":{"requestId":"r"}}`,
			strings.Join(records, ","),
			cursor,
		)
	}
}

func logError(status int, code string, header map[string]string) func(http.ResponseWriter, url.Values) {
	return func(response http.ResponseWriter, _ url.Values) {
		for name, value := range header {
			response.Header().Set(name, value)
		}
		response.WriteHeader(status)
		fmt.Fprintf(response, `{"error":{"code":%q,"message":"fixed message"},"meta":{"requestId":"r"}}`, code)
	}
}

func logLine(second int, level, message string) string {
	return fmt.Sprintf(
		`{"type":"line","time":"2026-09-30T12:00:%02d.000000001Z","stream":{"source":"gateway"},"contentClass":"operational","kind":"openclaw","level":%q,"message":%q,"subsystem":"gateway","fields":{"status":503,"method":"GET /x"}}`,
		second, level, message,
	)
}

const gapRecord = `{"type":"gap","time":null,"stream":{"source":"gateway"},"reason":"stream_replaced","remedy":"Container restarted; showing the new instance."}`

func runLogsCommand(t *testing.T, ctx context.Context, stub *runtimeLogStub, args ...string) (string, string, error) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(stub.serve))
	t.Cleanup(server.Close)
	keyFile := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut strings.Builder
	command := New(&out, &errOut)
	command.SetArgs(append(args, "--url", server.URL, "--service-key-file", keyFile, "--namespace", "ns_1"))
	err := command.ExecuteContext(ctx)
	return out.String(), errOut.String(), err
}

func recordSleeps(t *testing.T) *[]time.Duration {
	t.Helper()
	sleeps := []time.Duration{}
	original := sleepContext
	sleepContext = func(ctx context.Context, d time.Duration) error {
		sleeps = append(sleeps, d)
		return ctx.Err()
	}
	t.Cleanup(func() { sleepContext = original })
	return &sleeps
}

func TestAgentLogsBuildsTheQueryAndDefaultsToTheActiveRevision(t *testing.T) {
	stub := &runtimeLogStub{t: t, activeID: "rev_1", pages: []func(http.ResponseWriter, url.Values){
		logPage("v1.a.b", logLine(1, "warn", "slow start")),
	}}
	out, _, err := runLogsCommand(t, context.Background(), stub,
		"agent", "logs", "agt_1", "--source", "gateway", "--pod", "gw-0", "--previous", "--tail", "50", "--since", "10m")
	if err != nil {
		t.Fatal(err)
	}
	want := url.Values{
		"source": {"gateway"}, "pod": {"gw-0"}, "previous": {"true"},
		"tailLines": {"50"}, "sinceSeconds": {"600"},
	}
	if !reflect.DeepEqual(stub.queries[0], want) {
		t.Fatalf("query = %v, want %v", stub.queries[0], want)
	}
	if got := strings.TrimSpace(out); got != `2026-09-30T12:00:01.000000001Z WARN openclaw [gateway] slow start method="GET /x" status=503` {
		t.Fatalf("text output = %q", got)
	}
}

func TestAgentLogsReadsTheSandboxSourceWithoutAPod(t *testing.T) {
	stub := &runtimeLogStub{t: t, activeID: "rev_1", pages: []func(http.ResponseWriter, url.Values){
		logPage("v1.a.b", logLine(1, "warn", "slow start")),
	}}
	if _, _, err := runLogsCommand(t, context.Background(), stub,
		"agent", "logs", "agt_1", "--source", "sandbox", "--tail", "20"); err != nil {
		t.Fatal(err)
	}
	want := url.Values{"source": {"sandbox"}, "tailLines": {"20"}}
	if !reflect.DeepEqual(stub.queries[0], want) {
		t.Fatalf("query = %v, want %v", stub.queries[0], want)
	}
}

func TestAgentLogsRejectsInvalidFlagsBeforeAnyRequest(t *testing.T) {
	for _, args := range [][]string{
		{"agent", "logs", "agt_1"},
		{"agent", "logs", "agt_1", "--source", "kubelet"},
		{"agent", "logs", "agt_1", "--source", "kubelet-sandbox"},
		{"agent", "logs", "agt_1", "--source", "sandbox", "--pod", "gw-0"},
		{"agent", "logs", "agt_1", "--source", "sandbox", "--previous"},
		{"agent", "logs", "my-agent", "--source", "gateway"},
		{"agent", "runtime", "my-agent"},
		{"agent", "logs", "agt_1", "--source", "gateway", "--tail", "0"},
		{"agent", "logs", "agt_1", "--source", "gateway", "--tail", "1001"},
		{"agent", "logs", "agt_1", "--source", "gateway", "--since", "25h"},
		{"agent", "logs", "agt_1", "--source", "gateway", "--follow", "--previous"},
		{"agent", "logs", "agt_1", "--source", "gateway", "-o", "yaml"},
		{"agent", "runtime", "agt_1", "-o", "text"},
	} {
		stub := &runtimeLogStub{t: t, activeID: "rev_1"}
		if _, _, err := runLogsCommand(t, context.Background(), stub, args...); err == nil {
			t.Errorf("%v: expected an error", args)
		}
		if len(stub.queries) != 0 {
			t.Errorf("%v: sent %d log requests", args, len(stub.queries))
		}
	}
	stub := &runtimeLogStub{t: t}
	_, _, err := runLogsCommand(t, context.Background(), stub, "agent", "logs", "agt_1", "--source", "gateway")
	if err == nil || !strings.Contains(err.Error(), "has no readable revisions") {
		t.Fatalf("expected a missing revision error, got %v", err)
	}
	if len(stub.queries) != 0 {
		t.Fatalf("sent %d log requests for an Agent without revisions", len(stub.queries))
	}
}

// A first deploy that fails leaves no active revision; the failed version is
// the one an operator needs to inspect, so runtime and logs default to it.
func TestAgentRuntimeAndLogsDefaultToLatestRevisionWithoutActiveRevision(t *testing.T) {
	revisions := `[{"id":"rev_1","revision":1},{"id":"rev_2","revision":2}]`
	stub := &runtimeLogStub{t: t, revisions: revisions, pages: []func(http.ResponseWriter, url.Values){
		logPage("", logLine(1, "error", "startup failed")),
	}}
	out, errOut, err := runLogsCommand(t, context.Background(), stub, "agent", "logs", "agt_1", "--source", "gateway")
	if err != nil {
		t.Fatalf("logs: %v", err)
	}
	if !strings.Contains(out, "startup failed") {
		t.Fatalf("logs output = %q", out)
	}
	if !strings.Contains(errOut, "has no active revision; using latest revision rev_2") {
		t.Fatalf("logs notice = %q", errOut)
	}
	_, runtimeErr, err := runLogsCommand(t, context.Background(), stub, "agent", "runtime", "agt_1")
	if err != nil {
		t.Fatalf("runtime: %v", err)
	}
	if want := "/namespaces/ns_1/agents/agt_1/deployments/rev_2/runtime"; !slices.Contains(stub.paths, want) {
		t.Fatalf("runtime requests = %v, want %s", stub.paths, want)
	}
	if !strings.Contains(runtimeErr, "using latest revision rev_2") {
		t.Fatalf("runtime notice = %q", runtimeErr)
	}
}

func TestAgentLogsFollowPollsTheCursorHonoursRetryAfterAndPrintsGapNotices(t *testing.T) {
	sleeps := recordSleeps(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stub := &runtimeLogStub{t: t, activeID: "rev_1"}
	stub.pages = []func(http.ResponseWriter, url.Values){
		logPage("v1.first.sig", logLine(1, "info", "ready")),
		logError(http.StatusTooManyRequests, "RUNTIME_LOGS_RATE_LIMITED", map[string]string{"retry-after": "5"}),
		logPage("v1.second.sig", gapRecord, logLine(2, "error", "after restart")),
		logError(http.StatusBadRequest, "RUNTIME_LOGS_CURSOR_INVALID", nil),
		func(response http.ResponseWriter, query url.Values) {
			cancel() // Ctrl-C while following
			logPage("v1.third.sig")(response, query)
		},
	}
	out, errOut, err := runLogsCommand(t, ctx, stub,
		"agent", "logs", "agt_1", "--source", "gateway", "--since", "90s", "--follow", "-o", "json")
	if err != nil {
		t.Fatalf("an interrupted follow exits cleanly: %v", err)
	}
	cursors := []string{}
	for _, query := range stub.queries {
		cursors = append(cursors, query.Get("cursor"))
	}
	if want := []string{"", "v1.first.sig", "v1.first.sig", "v1.second.sig", ""}; !reflect.DeepEqual(cursors, want) {
		t.Fatalf("cursors = %v, want %v", cursors, want)
	}
	if stub.queries[1].Get("sinceSeconds") != "" || stub.queries[0].Get("sinceSeconds") != "90" {
		t.Fatalf("only the first request carries --since: %v", stub.queries)
	}
	// A rejected cursor starts a new view at once; an interrupted request ends the loop.
	if want := []time.Duration{2 * time.Second, 5 * time.Second, 2 * time.Second}; !reflect.DeepEqual(*sleeps, want) {
		t.Fatalf("sleeps = %v, want %v", *sleeps, want)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 3 {
		t.Fatalf("NDJSON lines = %d: %q", len(lines), out)
	}
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("not NDJSON: %q", line)
		}
	}
	if !strings.Contains(lines[1], `"reason":"stream_replaced"`) {
		t.Fatalf("gap record missing from NDJSON: %q", lines[1])
	}
	for _, notice := range []string{
		"notice: rate limited; retrying in 5s",
		"notice: - gap stream_replaced: Container restarted; showing the new instance.",
		"notice: the cursor was rejected; starting a new view",
	} {
		if !strings.Contains(errOut, notice) {
			t.Errorf("stderr lacks %q:\n%s", notice, errOut)
		}
	}
}

func TestAgentLogsExitsNonZeroWhenLogsAreUnsupportedOrUnavailable(t *testing.T) {
	recordSleeps(t)
	for _, test := range []struct {
		status int
		code   string
		follow bool
	}{
		{http.StatusNotImplemented, "NOT_IMPLEMENTED", false},
		{http.StatusNotImplemented, "NOT_IMPLEMENTED", true},
		{http.StatusServiceUnavailable, "RUNTIME_LOGS_CLUSTER_RBAC", true},
		{http.StatusServiceUnavailable, "RUNTIME_LOGS_UNAVAILABLE", false},
		{http.StatusForbidden, "FORBIDDEN", true},
	} {
		stub := &runtimeLogStub{t: t, activeID: "rev_1", pages: []func(http.ResponseWriter, url.Values){
			logPage("v1.first.sig", logLine(1, "info", "ready")),
			logError(test.status, test.code, nil),
		}}
		args := []string{"agent", "logs", "agt_1", "--source", "gateway"}
		if test.follow {
			args = append(args, "--follow")
		} else {
			stub.pages = stub.pages[1:]
		}
		_, _, err := runLogsCommand(t, context.Background(), stub, args...)
		var apiErr *occclient.APIError
		if !errors.As(err, &apiErr) || apiErr.Status != test.status || apiErr.Code != test.code {
			t.Errorf("%d %s follow=%v: err = %v", test.status, test.code, test.follow, err)
		}
	}
}

func TestAgentRuntimePrintsPodsAndSources(t *testing.T) {
	stub := &runtimeLogStub{t: t, activeID: "rev_1"}
	out, _, err := runLogsCommand(t, context.Background(), stub, "agent", "runtime", "agt_1", "--revision", "rev_1")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"gw-0", "Running", "OOMKilled exit 137", "current and previous instance"} {
		if !strings.Contains(out, want) {
			t.Errorf("runtime table lacks %q:\n%s", want, out)
		}
	}
}
