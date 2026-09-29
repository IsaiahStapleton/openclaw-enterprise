package occdev

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// fakeEngine puts a container engine named after the runner's selection on
// PATH. It answers only the inspect commands image resolution issues, so a
// test passes only when resolution asks what the real CLI supports.
func fakeEngine(t *testing.T, engine string, script string) {
	t.Helper()
	directory := t.TempDir()
	body := "#!/bin/sh\ncase \"$*\" in\n" + script +
		"*) echo \"unexpected: " + engine + " $*\" >&2; exit 99 ;;\nesac\n"
	if err := os.WriteFile(filepath.Join(directory, engine), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestEngineImageReferenceQualifiesAPodmanLocalBuild(t *testing.T) {
	// Podman stores an unqualified local build under the `localhost` registry.
	// Both `k3d image import` and containerd match the recorded name exactly,
	// so resolution must report the qualified name rather than the requested
	// one; the requested name finds no image and startup cannot continue.
	fakeEngine(t, "podman", `
"image inspect --format {{json .RepoTags}} openclaw-enterprise-runtime:kubernetes-quickstart") echo '["localhost/openclaw-enterprise-runtime:kubernetes-quickstart"]' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	reference, err := r.engineImageReference(context.Background(), "openclaw-enterprise-runtime:kubernetes-quickstart")
	if err != nil {
		t.Fatal(err)
	}
	if reference != "localhost/openclaw-enterprise-runtime:kubernetes-quickstart" {
		t.Fatalf("unexpected recorded reference: %q", reference)
	}
}

func TestEngineImageReferenceSelectsTheRequestedTagAmongSeveral(t *testing.T) {
	// A staging tag shares its image with the build it was tagged from, so the
	// engine reports both names. Resolution must return the requested one;
	// importing the other would stage an unrelated reference into the cluster.
	fakeEngine(t, "podman", `
"image inspect --format {{json .RepoTags}} openclaw-development/import-abc:occ-dev-1") echo '["localhost/openclaw-development/import-abc:occ-dev-1","localhost/openclaw-enterprise-runtime:kubernetes-quickstart"]' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	reference, err := r.engineImageReference(context.Background(), "openclaw-development/import-abc:occ-dev-1")
	if err != nil {
		t.Fatal(err)
	}
	if reference != "localhost/openclaw-development/import-abc:occ-dev-1" {
		t.Fatalf("resolution selected an unrelated tag: %q", reference)
	}
}

func TestEngineImageReferencePreservesADockerName(t *testing.T) {
	// Docker keeps an unqualified name as written, so resolution must leave it
	// alone and not invent a registry the engine does not record.
	fakeEngine(t, "docker", `
"image inspect --format {{json .RepoTags}} openclaw-enterprise-runtime:kubernetes-quickstart") echo '["openclaw-enterprise-runtime:kubernetes-quickstart"]' ;;
`)
	r := &runner{engine: "docker", env: map[string]string{}}

	reference, err := r.engineImageReference(context.Background(), "openclaw-enterprise-runtime:kubernetes-quickstart")
	if err != nil {
		t.Fatal(err)
	}
	if reference != "openclaw-enterprise-runtime:kubernetes-quickstart" {
		t.Fatalf("a Docker name was rewritten: %q", reference)
	}
}

func TestEngineImageReferencePreservesAFullyQualifiedName(t *testing.T) {
	// An explicitly selected registry image is already qualified, so neither
	// engine rewrites it and resolution must return it unchanged.
	fakeEngine(t, "podman", `
"image inspect --format {{json .RepoTags}} quay.io/openclaw/runtime:v1") echo '["quay.io/openclaw/runtime:v1"]' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	reference, err := r.engineImageReference(context.Background(), "quay.io/openclaw/runtime:v1")
	if err != nil {
		t.Fatal(err)
	}
	if reference != "quay.io/openclaw/runtime:v1" {
		t.Fatalf("a qualified name was rewritten: %q", reference)
	}
}

func TestEngineImageReferenceRejectsAnImageWithNoMatchingTag(t *testing.T) {
	// An untagged image cannot be imported by name. Fail here rather than hand
	// k3d a reference the cluster will never resolve.
	fakeEngine(t, "podman", `
"image inspect --format {{json .RepoTags}} openclaw-enterprise-runtime:kubernetes-quickstart") echo '[]' ;;
`)
	r := &runner{engine: "podman", env: map[string]string{}}

	if _, err := r.engineImageReference(context.Background(), "openclaw-enterprise-runtime:kubernetes-quickstart"); err == nil {
		t.Fatal("resolution accepted an image with no matching tag")
	}
}
