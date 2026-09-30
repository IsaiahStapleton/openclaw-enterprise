package occcli

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const (
	testNamespaceID = "ns_11111111-1111-4111-8111-111111111111"
	testAgentID     = "agt_22222222-2222-4222-8222-222222222222"
	testRevision1ID = "rev_33333333-3333-4333-8333-333333333333"
	testRevision2ID = "rev_44444444-4444-4444-8444-444444444444"
)

type fakeOCC struct {
	mu        sync.Mutex
	responses map[string]string
	requested []string
}

func (fake *fakeOCC) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	key := request.Method + " " + request.URL.Path
	fake.mu.Lock()
	fake.requested = append(fake.requested, key)
	fake.mu.Unlock()
	data, ok := fake.responses[key]
	if !ok {
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"not found"}}`))
		return
	}
	writer.Header().Set("content-type", "application/json")
	_, _ = writer.Write([]byte(`{"data":` + data + `,"meta":{"requestId":"req_test"}}`))
}

func runOCC(t *testing.T, responses map[string]string, args ...string) (string, []string, error) {
	t.Helper()
	fake := &fakeOCC{responses: responses}
	server := httptest.NewServer(fake)
	defer server.Close()
	keyFile := filepath.Join(t.TempDir(), "service-key.json")
	if err := os.WriteFile(keyFile, []byte(`{"data":{"key":"test-key"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	command := New(&out, &bytes.Buffer{})
	command.SetArgs(append([]string{"--url", server.URL, "--service-key-file", keyFile}, args...))
	err := command.Execute()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return out.String(), append([]string(nil), fake.requested...), err
}

func TestNamespaceTableLabelsTheAdoptedNamespaceColumn(t *testing.T) {
	out, _, err := runOCC(t, map[string]string{
		"GET /namespaces": `[{"id":"` + testNamespaceID + `","name":"team","status":"ready","createdAt":"2026-09-30T00:00:00.000Z"}]`,
	}, "namespace", "list")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "KUBERNETES NAMESPACE") || !strings.Contains(out, "ADOPTED NAMESPACE") {
		t.Fatalf("managed Namespaces must not read as having no Kubernetes namespace:\n%s", out)
	}
}

func TestAgentTableLabelsLifecycleSeparatelyFromDeploymentHealth(t *testing.T) {
	out, _, err := runOCC(t, map[string]string{
		"GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID: `{"id":"` + testAgentID + `","name":"a","status":"active","desiredRuntimeState":"running"}`,
	}, "--namespace", testNamespaceID, "agent", "get", testAgentID)
	if err != nil {
		t.Fatal(err)
	}
	header := strings.SplitN(out, "\n", 2)[0]
	if strings.Contains(header, " STATUS") || !strings.Contains(header, "LIFECYCLE") {
		t.Fatalf("Agent lifecycle must not be labeled STATUS:\n%s", out)
	}
}

func TestResourceCommandsRejectNamesWithAHintBeforeCallingOCC(t *testing.T) {
	cases := []struct {
		args []string
		hint string
	}{
		{[]string{"--namespace", testNamespaceID, "agent", "get", "dogfood-agent"}, "occ agent list"},
		{[]string{"--namespace", "default", "agent", "list"}, "occ namespace list"},
		{[]string{"namespace", "get", "default"}, "occ namespace list"},
		{[]string{"--namespace", testNamespaceID, "secret", "get", "model-key"}, "occ secret list"},
		{[]string{"--namespace", testNamespaceID, "agent", "deployment-status", testAgentID, "1"}, "occ agent revisions"},
	}
	for _, testCase := range cases {
		_, requested, err := runOCC(t, map[string]string{}, testCase.args...)
		if err == nil || !strings.Contains(err.Error(), testCase.hint) {
			t.Errorf("%v: expected an error pointing at %q, got %v", testCase.args, testCase.hint, err)
		}
		if len(requested) != 0 {
			t.Errorf("%v: expected no request, got %v", testCase.args, requested)
		}
	}
}

func TestSecretListShowsNamespaceSecrets(t *testing.T) {
	out, _, err := runOCC(t, map[string]string{
		"GET /namespaces/" + testNamespaceID + "/secrets": `[{"id":"sec_55555555-5555-4555-8555-555555555555","name":"model-key","namespaceId":"` + testNamespaceID + `","ref":{}}]`,
	}, "--namespace", testNamespaceID, "secret", "list")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "model-key") {
		t.Fatalf("expected the Secret in the list:\n%s", out)
	}
}

func agentRevisionsResponse() string {
	return `[{"id":"` + testRevision2ID + `","revision":2,"agentId":"` + testAgentID + `","createdAt":"2026-09-30T01:00:00.000Z"},` +
		`{"id":"` + testRevision1ID + `","revision":1,"agentId":"` + testAgentID + `","createdAt":"2026-09-30T00:00:00.000Z"}]`
}

func TestAgentRevisionsListsDeploymentIDs(t *testing.T) {
	out, _, err := runOCC(t, map[string]string{
		"GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID + "/revisions": agentRevisionsResponse(),
	}, "--namespace", testNamespaceID, "agent", "revisions", testAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, testRevision1ID) || !strings.Contains(out, testRevision2ID) {
		t.Fatalf("expected both revision IDs:\n%s", out)
	}
}

func TestDeploymentStatusDefaultsToTheLatestRevision(t *testing.T) {
	agentPath := "/namespaces/" + testNamespaceID + "/agents/" + testAgentID
	out, requested, err := runOCC(t, map[string]string{
		"GET " + agentPath + "/revisions": agentRevisionsResponse(),
		"GET " + agentPath + "/deployments/" + testRevision2ID: `{"deploymentId":"` + testRevision2ID + `","agentId":"` + testAgentID +
			`","namespaceId":"` + testNamespaceID + `","status":"failed","error":{"code":"CONVERGENCE_DEADLINE_EXCEEDED","message":"Deployment did not converge."}}`,
	}, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID)
	if err != nil {
		t.Fatalf("%v (requests %v)", err, requested)
	}
	if !strings.Contains(out, "failed") || !strings.Contains(out, "CONVERGENCE_DEADLINE_EXCEEDED") {
		t.Fatalf("expected the latest deployment failure:\n%s", out)
	}
}

func TestDeploymentStatusWithoutRevisionsExplainsHowToDeploy(t *testing.T) {
	_, _, err := runOCC(t, map[string]string{
		"GET /namespaces/" + testNamespaceID + "/agents/" + testAgentID + "/revisions": `[]`,
	}, "--namespace", testNamespaceID, "agent", "deployment-status", testAgentID)
	if err == nil || !strings.Contains(err.Error(), "occ agent deploy") {
		t.Fatalf("expected a deploy hint, got %v", err)
	}
}
