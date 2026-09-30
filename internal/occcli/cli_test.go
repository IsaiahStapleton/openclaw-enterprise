package occcli

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
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

func TestCredentialSourceUpdateAndWithdrawalCommandsReachTheirRoutes(t *testing.T) {
	type call struct{ method, path, body string }
	var calls []call
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		calls = append(calls, call{request.Method, request.URL.Path, string(body)})
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":{"id":"cs_1","state":"pending","requestedBy":"admin","reason":"CREDENTIAL_WITHDRAWAL_PENDING"},"meta":{"requestId":"req_1"}}`))
	}))
	defer server.Close()

	directory := t.TempDir()
	keyFile := filepath.Join(directory, "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(directory, "replacement.json")
	secrets := `{"secrets":{"api_key":{"kind":"secret","namespaceId":"ns_1","id":"sec_2"}}}`
	if err := os.WriteFile(replacement, []byte(secrets), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		args []string
		want call
	}{
		{[]string{"credential-source", "update", "cs_1"}, call{http.MethodPatch, "/namespaces/ns_1/credential-sources/cs_1", "{}"}},
		{[]string{"credential-source", "update", "cs_1", "--file", replacement}, call{http.MethodPatch, "/namespaces/ns_1/credential-sources/cs_1", secrets}},
		{[]string{"agent", "credential-withdrawal", "request", "agt_1", "cs_1"}, call{http.MethodPost, "/namespaces/ns_1/agents/agt_1/credential-sources/cs_1/withdraw", ""}},
		{[]string{"agent", "credential-withdrawal", "get", "agt_1", "cs_1"}, call{http.MethodGet, "/namespaces/ns_1/agents/agt_1/credential-sources/cs_1/withdrawal", ""}},
	} {
		calls = nil
		command := New(io.Discard, io.Discard)
		command.SetArgs(append(test.args, "--url", server.URL, "--service-key-file", keyFile, "--namespace", "ns_1"))
		if err := command.Execute(); err != nil {
			t.Fatalf("%v: %v", test.args, err)
		}
		if len(calls) != 1 || calls[0] != test.want {
			t.Fatalf("%v: got %+v, want %+v", test.args, calls, test.want)
		}
	}
}
