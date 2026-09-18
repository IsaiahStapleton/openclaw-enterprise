import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { kubernetesHash, validateExplicitK3dLoopbackContext } from "../helpers/kubernetes-real.mjs";
import { sessionEvidenceScript } from "../helpers/normal-agent-tools.mjs";
import {
  createInstalledRepositoryFixture,
  createRepositoryObserver,
  readProtectedInput,
  readInstalledCredentialSession,
  submitRepositoryTaskScript,
} from "../helpers/repository-credentials-installed.mjs";

const selected = process.env.OCC_TEST_REPOSITORY_CREDENTIALS_REAL === "1";
const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const workspace = "/home/node/.openclaw/workspace";

// This case proves the installed caller path that host-driven Git/gh smoke tests
// cannot: the model acts using material opened by the production worker.
test(
  "installed embedded Agent clones, edits, commits, pushes and creates a native repository PR",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_REPOSITORY_CREDENTIALS_REAL=1 with explicit authorized repository, protected App inputs, model key and immutable images.",
    timeout: 1800000,
  },
  async (context) => {
    assert.equal(
      process.env.OCC_TEST_REPOSITORY_CREDENTIALS_AUTHORIZED,
      "1",
      "explicit disposable-repository write and cleanup authorization is required",
    );
    await validateExplicitK3dLoopbackContext(selection);
    const repository = process.env.OCC_TEST_REPOSITORY_CREDENTIALS_REPOSITORY;
    assert.match(
      repository ?? "",
      /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
    );
    const images = Object.fromEntries(
      [
        ["controller", "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE"],
        ["runtime", "OCC_TEST_KUBERNETES_RUNTIME_IMAGE"],
        ["postgres", "OCC_TEST_PRODUCTION_POSTGRES_IMAGE"],
        ["node", "OCC_TEST_PRODUCTION_NODE_IMAGE"],
        ["credentials", "OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE"],
      ].map(([name, variable]) => {
        const value = process.env[variable];
        assert.match(
          value ?? "",
          /^\S+@sha256:[a-f0-9]{64}$/,
          `${variable} must select an immutable image`,
        );
        return [name, value];
      }),
    );
    const upstreamCidrs = (process.env.OCC_TEST_REPOSITORY_CREDENTIALS_UPSTREAM_CIDRS ?? "")
      .split(",")
      .filter(Boolean);
    assert.ok(
      upstreamCidrs.length > 0 && upstreamCidrs.length <= 64,
      "explicit approved provider IPv4 /32 egress is required",
    );
    for (const cidr of upstreamCidrs) {
      const parts = cidr.split("/");
      assert.equal(parts[1], "32", "provider egress must select exact IPv4 addresses");
      assert.ok(
        /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(parts[0]) &&
          parts[0].split(".").every((octet) => Number(octet) <= 255),
      );
      assert.ok(
        !/^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(parts[0]),
        "provider egress must be public",
      );
    }
    const modelKey = process.env.OPENAI_API_KEY;
    assert.ok(modelKey, "an authorized model credential is required");
    const model = process.env.OCC_TEST_OPENAI_MODEL;
    assert.ok(model, "OCC_TEST_OPENAI_MODEL must explicitly select the model");
    const app = JSON.parse(
      await readProtectedInput(
        process.env.OCC_TEST_REPOSITORY_CREDENTIALS_APP_CONFIG_FILE,
        "App identity input",
      ),
    );
    assert.deepEqual(Object.keys(app).sort(), ["appId", "githubInstallationId", "repositoryId"]);
    for (const value of Object.values(app)) assert.match(value, /^[1-9][0-9]{0,15}$/);
    const appKey = await readProtectedInput(
      process.env.OCC_TEST_REPOSITORY_CREDENTIALS_APP_KEY_FILE,
      "App key input",
    );
    const f = await createInstalledRepositoryFixture(context, { selection, images, modelKey });
    f.secrets.push(appKey);
    const observe = createRepositoryObserver({
      run: f.run,
      repository,
      binary: process.env.OCC_TEST_REPOSITORY_CREDENTIALS_GH_BINARY,
    });
    const { data: remote } = await observe("GET");
    assert.equal(
      String(remote.id),
      app.repositoryId,
      "authorized registry repository ID must match independent provider readback",
    );
    assert.equal(remote.full_name.toLowerCase(), repository.toLowerCase());
    const base = remote.default_branch;
    assert.equal(typeof base, "string");
    const { data: baseline } = await observe("GET", `git/ref/heads/${encodeURIComponent(base)}`);
    const baseSha = baseline.object.sha;
    assert.match(baseSha, /^[a-f0-9]{40}$/);
    const branch = `oce-credential-proof-${f.suffix}`;
    const file = `credential-proof-${f.suffix}.txt`;
    const content = `Installed repository credential proof ${f.suffix}\n`;
    const marker = `<!-- oce-credential-proof:${f.suffix} -->`;
    assert.equal((await observe("GET", `git/ref/heads/${branch}`, undefined, 404)).status, 404);
    let agent,
      workerPod,
      revision,
      gateway,
      attempt,
      taskStarted = false,
      agentStopped = false,
      workFailure,
      remoteEvidence;
    const cleanupFailures = [];
    try {
      const providerId = "repository-proof";
      const repositoryRef = "authorized-repository";
      const driverId = "repository-proof-driver";
      const origin = `https://openclaw-enterprise-repository-credentials.${f.system}.svc`;
      const registry = {
        version: 1,
        providerId,
        providerInstanceId: "github-public",
        ...app,
        maximumDurationSeconds: 3600,
        repositories: [
          {
            repositoryRef,
            repositoryId: app.repositoryId,
            repository,
            namespaces: [{ namespaceId: f.namespace.id, profiles: ["git-full"] }],
          },
        ],
      };
      delete registry.repositoryId;
      await f.apply({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: f.metadata("repository-registry-v1"),
        immutable: true,
        data: { "registry.json": JSON.stringify(registry) },
      });
      await f.run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-keyout",
        join(f.directory, "repository-tls.key"),
        "-out",
        join(f.directory, "repository-tls.crt"),
        "-subj",
        "/CN=repository-credentials",
        "-addext",
        `subjectAltName=DNS:${new URL(origin).hostname}`,
      ]);
      const tlsKey = await readFile(join(f.directory, "repository-tls.key"), "utf8");
      f.secrets.push(tlsKey);
      const tlsCert = await readFile(join(f.directory, "repository-tls.crt"), "utf8");
      const socket = "/run/openclaw/repository-control/private/control.sock";
      await f.createSecret("repository-app-key", { "private-key.pem": appKey });
      await f.createSecret("repository-tls", { "tls.crt": tlsCert, "tls.key": tlsKey });
      await f.createSecret("repository-public-ca", { "ca.crt": tlsCert });
      await f.createSecret("repository-service-config", {
        "config.json": JSON.stringify({
          gateway: {
            publicOrigin: origin,
            listen: "0.0.0.0:8443",
            controlSocket: socket,
            tlsCertFile: "/etc/openclaw/repository-inputs/tls.crt",
            tlsKeyFile: "/etc/openclaw/repository-inputs/tls.key",
          },
          sessionPolicy: {
            maximumDurationSeconds: 3600,
            defaultProfile: "git-full",
            allowedProfiles: ["git-full"],
          },
          limits: {},
          backend: {
            kind: "github-app-registry",
            providerId,
            registryFile: "/etc/openclaw/repository-registry/registry.json",
            privateKeyFile: "/etc/openclaw/repository-inputs/private-key.pem",
          },
        }),
      });
      f.configuration.provider = [
        {
          id: providerId,
          type: "github",
          configuration: { registryPath: "/etc/openclaw/repository-registry/registry.json" },
          drivers: { repository_credentials: driverId },
        },
      ];
      f.configuration.drivers.repository_credentials = {
        id: driverId,
        configuration: {
          controlSocket: socket,
          sessionDurationSeconds: 1800,
          publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
        },
      };
      const workerLabels = {
        "app.kubernetes.io/name": "openclaw-enterprise",
        "app.kubernetes.io/instance": f.release,
        "app.kubernetes.io/component": "worker",
      };
      f.configuration.drivers.compute.configuration.network.repositoryCredentials = {
        namespace: f.system,
        podLabels: workerLabels,
        port: 8443,
      };
      await f.upgrade({
        enabled: true,
        image: images.credentials,
        providerId,
        registryConfigMapName: "repository-registry-v1",
        registryKey: "registry.json",
        serviceConfigSecretName: "repository-service-config",
        serviceConfigKey: "config.json",
        appKeySecretName: "repository-app-key",
        appKeyKey: "private-key.pem",
        tlsSecretName: "repository-tls",
        publicCaSecretName: "repository-public-ca",
        publicCaKey: "ca.crt",
        upstreamCidrs,
      });
      // The service shares the worker Pod but neither the API nor worker process
      // receives App key/TLS mounts or the Agent's model credential.
      const pods = await f.kubernetes.resources("pods", f.system);
      for (const component of ["api", "worker"]) {
        const pod = pods.find(
          (p) =>
            p.metadata.labels?.["app.kubernetes.io/component"] === component &&
            !p.metadata.deletionTimestamp &&
            p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
        );
        assert.ok(pod, `${component} must be installed and Ready`);
        const container = pod.spec.containers.find((c) => c.name === component);
        assert.ok(container);
        assert.equal(container.image, images.controller);
        assert.ok(
          !(container.env ?? []).some((e) => /OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN/.test(e.name)),
        );
        assert.ok(
          !(container.volumeMounts ?? []).some((m) =>
            ["repository-inputs", "repository-private"].includes(m.name),
          ),
        );
        if (component === "worker") {
          workerPod = pod;
          assert.equal(
            pod.spec.containers.find((c) => c.name === "repository-credentials")?.image,
            images.credentials,
          );
        }
      }
      const native = createHarnessConfiguration("openclaw", model);
      native.agents.defaults.skipBootstrap = true;
      native.agents.defaults.workspace = workspace;
      native.agents.defaults.sandbox = { mode: "off" };
      native.tools = { allow: ["exec", "process"], exec: { host: "gateway", mode: "full" } };
      const secret = await f.api(
        "POST",
        `/namespaces/${f.namespace.id}/secrets`,
        { name: "repository-model", value: modelKey },
        201,
      );
      const configuration = await f.api(
        "POST",
        `/namespaces/${f.namespace.id}/configurations`,
        { kind: "agent", values: native },
        201,
      );
      agent = await f.api(
        "POST",
        `/namespaces/${f.namespace.id}/agents`,
        {
          name: `repository-${f.suffix}`,
          configurationId: configuration.id,
          executionMode: "embedded",
          harnessAuth: { method: "api_key", source: secret.ref },
          repositoryBindings: [{ repositoryRef, profile: "git-full" }],
        },
        201,
      );
      const agentPath = `/namespaces/${f.namespace.id}/agents/${agent.id}`;
      // The supported administrator grant binds only the Agent's persisted service
      // Principal and its exact model Secret; it does not grant repository authority.
      const grant = await f.sql(
        `WITH principal AS (SELECT service_principal_id FROM occ.agents WHERE namespace_id=${sqlLiteral(f.namespace.id)} AND id=${sqlLiteral(agent.id)}), role AS (INSERT INTO occ.iam_roles (id,namespace_id,name,permissions) SELECT ${sqlLiteral(`role-${f.suffix}`)},${sqlLiteral(f.namespace.id)},'Harness Secret operate','[{"action":"operate","resourceKind":"secret"}]'::jsonb FROM principal RETURNING id), binding AS (INSERT INTO occ.iam_access_bindings (id,namespace_id,identity_subject_id,role_id,resource_kind,resource_id) SELECT ${sqlLiteral(`binding-${f.suffix}`)},${sqlLiteral(f.namespace.id)},principal.service_principal_id,role.id,'secret',${sqlLiteral(secret.id)} FROM principal CROSS JOIN role RETURNING id) SELECT count(*) FROM binding;`,
      );
      assert.equal(grant, "1");
      await f.api("POST", `${agentPath}/runtime-credentials`, {}, 200);
      revision = await f.api("POST", `${agentPath}/deploy`, undefined, 202);
      assert.deepEqual(revision.repositoryCredentials.bindings, [
        { repositoryRef, profile: "git-full" },
      ]);
      await f.waitFor(
        "admitted Agent revision active",
        async () => (await f.api("GET", agentPath)).activeRevisionId === revision.id,
        300000,
      );
      const configMap = `gateway-${kubernetesHash(agent.id)}-rev-${kubernetesHash(revision.id)}`;
      gateway = await f.waitFor("one Ready Pod serving the exact admitted revision", async () => {
        const candidates = (
          await f.kubernetes.resources(
            "pods",
            f.tenant,
            "-l",
            `openclaw.dev/agent=${agent.id},openclaw.dev/workload-role=gateway`,
          )
        ).filter(
          (p) =>
            !p.metadata.deletionTimestamp &&
            p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True") &&
            p.spec.volumes.some((v) => v.configMap?.name === configMap),
        );
        assert.ok(candidates.length <= 1);
        return candidates[0] ?? false;
      });
      const gatewayContainer = gateway.spec.containers.find((c) => c.name === "gateway");
      assert.equal(gatewayContainer?.image, images.runtime);
      assert.ok(
        gatewayContainer.env
          .find((value) => value.name === "PATH")
          ?.value.startsWith("/opt/oce/repository-credentials/bin:"),
        "regular Git/gh commands must use the delivered client",
      );
      assert.ok(
        !gatewayContainer.env.some((value) =>
          ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(
            value.name,
          ),
        ),
        "no alternate GitHub credential may enter the Agent",
      );
      assert.ok(
        !gateway.spec.volumes.some((v) =>
          ["repository-app-key", "repository-tls", "repository-service-config"].includes(
            v.secret?.secretName,
          ),
        ),
      );
      const exec = (script, args = [], input, timeout = 30000) =>
        f.run(
          "kubectl",
          [
            ...f.kubernetes.kubectlArguments([]),
            "-n",
            f.tenant,
            "exec",
            "-i",
            gateway.metadata.name,
            "-c",
            "gateway",
            "--",
            "env",
            "-u",
            "OPENAI_API_KEY",
            "node",
            "-e",
            script,
            ...args,
          ],
          { input, timeout },
        );
      const versions = JSON.parse(
        await exec(
          `const fs=require('node:fs'); console.log(JSON.stringify({node:process.version,openclaw:JSON.parse(fs.readFileSync('/app/node_modules/openclaw/package.json','utf8')).version,repositoryClient:JSON.parse(fs.readFileSync('/opt/oce/repository-credentials/package.json','utf8')).version}));`,
        ),
      );
      assert.match(versions.openclaw, /^\d+\.\d+\.\d+/);
      const service = await f.get("service", "openclaw-enterprise-repository-credentials");
      const probe = `const net=require('node:net'); const socket=net.createConnection({host:process.argv[1],port:443}); let done=false; function finish(result){if(done)return;done=true;console.log(result);socket.destroy()}socket.setTimeout(3000);socket.on('connect',()=>finish('connected'));socket.on('timeout',()=>finish('timeout'));socket.on('error',error=>finish(error.code));`;
      assert.equal((await exec(probe, [service.spec.clusterIP])).trim(), "connected");
      const denied = (
        await f.run(
          "kubectl",
          [
            ...f.kubernetes.kubectlArguments([]),
            "-n",
            f.system,
            "exec",
            "operator",
            "--",
            "node",
            "-e",
            probe,
            service.spec.clusterIP,
          ],
          { timeout: 10000 },
        )
      ).trim();
      assert.ok(
        ["timeout", "EHOSTUNREACH", "ECONNREFUSED"].includes(denied),
        "an unapproved Pod must not connect to the same listening credential service",
      );
      await f.record("Credential service allows the Agent and denies an unapproved Pod", {
        targetPort: 443,
        serviceTargetPort: 8443,
        denied,
      });
      const attempts = JSON.parse(
        await f.sql(
          `SELECT coalesce(json_agg(json_build_object('sessionId',session_id,'repositoryRef',repository_ref,'phase',phase,'revisionId',revision_id,'agentId',agent_id)), '[]') FROM occ.repository_session_attempts WHERE namespace_id=${sqlLiteral(f.namespace.id)} AND agent_id=${sqlLiteral(agent.id)} AND revision_id=${sqlLiteral(revision.id)};`,
        ),
      );
      assert.equal(attempts.length, 1);
      attempt = attempts[0];
      assert.equal(attempt.phase, "open");
      assert.equal(attempt.repositoryRef, repositoryRef);
      assert.ok(attempt.sessionId);
      const openedSession = await readInstalledCredentialSession(f, workerPod, attempt.sessionId);
      assert.equal(openedSession.sessionId, attempt.sessionId);
      assert.equal(openedSession.state, "OPEN");
      const material = JSON.parse(
        await exec(
          `const fs=require('node:fs'); const p='/run/oce/repository-credentials/manifest.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); const st=fs.statSync(p); console.log(JSON.stringify({uid:st.uid,mode:st.mode&0o777,generation:m.generation,bindings:m.bindings.map(b=>({repositoryRef:b.repositoryRef,sessionId:b.sessionId}))}));`,
        ),
      );
      assert.equal(material.uid, 1000);
      assert.equal(material.mode, 0o600);
      assert.deepEqual(material.bindings, [{ repositoryRef, sessionId: attempt.sessionId }]);
      await f.run("kubectl", [
        ...f.kubernetes.kubectlArguments([]),
        "-n",
        f.tenant,
        "exec",
        gateway.metadata.name,
        "-c",
        "gateway",
        "--",
        "node",
        "/app/openclaw.mjs",
        "config",
        "validate",
        "--json",
      ]);
      await f.record("Installed Agent admitted one worker-owned repository session", {
        namespaceId: f.namespace.id,
        agentId: agent.id,
        revisionId: revision.id,
        pod: gateway.metadata.name,
        podUid: gateway.metadata.uid,
        sessionId: attempt.sessionId,
        generation: material.generation,
        model,
        versions,
        runtimeImageId: gateway.status.containerStatuses.find((status) => status.name === "gateway")
          ?.imageID,
        workerImageIds: workerPod.status.containerStatuses.map((status) => ({
          name: status.name,
          imageID: status.imageID,
        })),
      });
      const sessionKey = `agent:main:repository-proof-${f.suffix}`;
      const checkout = `${workspace}/${repository.split("/")[1]}`;
      const commandSpecs = [
        {
          operation: "clone",
          workdir: workspace,
          argv: ["git", "clone", `https://github.com/${repository}.git`],
        },
        { operation: "fetch", workdir: checkout, argv: ["git", "fetch", "origin"] },
        { operation: "readBase", workdir: checkout, argv: ["git", "rev-parse", `origin/${base}`] },
        { operation: "branch", workdir: checkout, argv: ["git", "switch", "-c", branch, baseSha] },
        { operation: "add", workdir: checkout, argv: ["git", "add", "--", file] },
        {
          operation: "commit",
          workdir: checkout,
          argv: ["git", "commit", "-m", `Installed credential proof ${f.suffix}`],
        },
        {
          operation: "push",
          workdir: checkout,
          argv: ["git", "push", "origin", `HEAD:refs/heads/${branch}`],
        },
        { operation: "readCommit", workdir: checkout, argv: ["git", "rev-parse", "HEAD"] },
        {
          operation: "nativePr",
          workdir: checkout,
          argv: [
            "gh",
            "pr",
            "create",
            "--base",
            base,
            "--head",
            branch,
            "--title",
            `Installed credential proof ${f.suffix}`,
            "--body",
            marker,
          ],
        },
      ];
      const quoteArgument = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
      const commands = commandSpecs
        .map(
          ({ operation, workdir, argv }) =>
            `${operation}: exec.workdir=${JSON.stringify(workdir)}, exec.command=${JSON.stringify(argv.map(quoteArgument).join(" "))}`,
        )
        .join("\n");
      const prompt = `Complete this authorized disposable repository task once with your exec tool and normal image-installed git/gh commands. Each Git/gh operation below must be its own standalone exec.command, with the specified exec.workdir. Execute the exact arguments in the listed order. Do not use shell cd, chaining, pipelines, redirection, comments, substitutions or wrappers in those Git/gh commands. Run foreground commands and stop on any failure. If exec nevertheless reports a running process, use process.poll on that exact session until completion before continuing. Do not install tools, read credentials, use alternate tokens, force push, call a provider HTTP API to create the PR, or delegate.
After clone, its natural destination is ${checkout}. The readBase output must equal ${baseSha}; stop if it differs. Between branch and add, configure local disposable Git identity Repository proof <repository-proof@example.invalid>, then use a separate exec call of your own to write exactly the following JSON-encoded bytes to the new root-level file ${file}: ${JSON.stringify(content)}. Author that file yourself; do not change any other file. Make exactly one commit and exactly one same-repository PR. readCommit prints the full commit SHA and nativePr prints the PR URL; do not substitute echo commands for either operation. Do not close the PR or delete its branch. Finish with ${marker}.
${commands}`;
      taskStarted = true;
      let taskFailure;
      try {
        const response = JSON.parse(
          await exec(
            submitRepositoryTaskScript,
            [],
            JSON.stringify({ sessionKey, prompt }),
            610000,
          ),
        );
        assert.equal(response.status, 200);
      } catch (error) {
        taskFailure = error;
      }
      // A timeout is an unknown mutation outcome. Read actual trace and provider
      // state once; never replay a model task or create the PR in the runner.
      const trace = JSON.parse(
        await exec(sessionEvidenceScript, [
          sessionKey,
          marker,
          "exec",
          marker,
          JSON.stringify({
            toolNames: ["exec", "process"],
            commands: commandSpecs,
          }),
        ]),
      );
      assert.equal(
        (await f.get("pod", gateway.metadata.name, f.tenant)).metadata.uid,
        gateway.metadata.uid,
        "the task must remain bound to the observed Agent Pod",
      );
      assert.equal((await f.api("GET", agentPath)).activeRevisionId, revision.id);
      assert.equal(
        (await readInstalledCredentialSession(f, workerPod, attempt.sessionId)).state,
        "OPEN",
      );
      const branchResponse = await observe("GET", `git/ref/heads/${branch}`, undefined, [200, 404]);
      assert.equal(branchResponse.status, 200, "model task must push its branch");
      const commitSha = branchResponse.data.object.sha;
      const { data: commit } = await observe("GET", `commits/${commitSha}`);
      assert.deepEqual(
        commit.parents.map((p) => p.sha),
        [baseSha],
      );
      assert.deepEqual(
        commit.files.map((value) => ({ filename: value.filename, status: value.status })),
        [{ filename: file, status: "added" }],
      );
      const { data: remoteFile } = await observe("GET", `contents/${file}?ref=${commitSha}`);
      assert.equal(Buffer.from(remoteFile.content, "base64").toString("utf8"), content);
      const { data: pulls } = await observe(
        "GET",
        `pulls?state=all&head=${encodeURIComponent(repository.split("/")[0] + ":" + branch)}&per_page=100`,
      );
      assert.equal(pulls.length, 1);
      const pull = pulls[0];
      assert.equal(pull.head.repo.id, Number(app.repositoryId));
      assert.equal(pull.head.ref, branch);
      assert.equal(pull.head.sha, commitSha);
      assert.equal(pull.base.repo.id, Number(app.repositoryId));
      assert.equal(pull.base.ref, base);
      assert.equal(pull.body, marker);
      assert.equal(pull.state, "open");
      remoteEvidence = { commitSha, pullNumber: pull.number };
      assert.equal(trace.exists, true);
      assert.equal(trace.promptReportSource, "run");
      assert.ok(trace.promptToolNames.includes("exec"));
      assert.equal(trace.userMarkerSeen, true);
      assert.equal(trace.assistantMarkerSeen, true);
      assert.equal(trace.terminalAssistantMarkerSeen, true);
      assert.equal(trace.assistantError, false);
      const succeeded = (result) =>
        !result.isError && result.status === "completed" && result.exitCode === 0;
      const completionFor = (call) => {
        const result = trace.results.find(
          (result) => result.toolCallId === call.id && result.seq > call.seq,
        );
        if (!result || result.isError) return undefined;
        if (succeeded(result)) return result;
        // A running exec is proved only by a later successful poll of the exact
        // returned process session. Its output stays attached to that exec call.
        if (result.status !== "running" || typeof result.processSessionId !== "string")
          return undefined;
        for (const poll of trace.calls) {
          if (
            poll.name !== "process" ||
            poll.processAction !== "poll" ||
            poll.processSessionId !== result.processSessionId ||
            poll.seq <= result.seq
          )
            continue;
          const completed = trace.results.find(
            (done) =>
              done.toolCallId === poll.id &&
              done.processSessionId === result.processSessionId &&
              done.seq > poll.seq &&
              succeeded(done),
          );
          if (completed) return completed;
        }
        return undefined;
      };
      const paired = trace.calls
        .filter((call) => call.name === "exec")
        .map((call) => ({ ...call, completion: completionFor(call) }))
        .filter((call) => call.completion);
      for (const { operation } of commandSpecs)
        assert.ok(
          paired.some((call) => call.operations.includes(operation)),
          `successful standalone tool trace must account for ${operation}`,
        );
      assert.ok(
        paired.some(
          (call) =>
            call.operations.includes("readBase") && call.completion.commitShas.includes(baseSha),
        ),
        "the fetch must be followed by a successful read of the independently observed base",
      );
      assert.ok(
        paired.some(
          (call) =>
            call.operations.includes("readCommit") &&
            call.completion.commitShas.includes(commitSha),
        ),
        "the successful git rev-parse HEAD result must identify the independently observed commit",
      );
      const expectedPullUrl = `https://github.com/${remote.full_name}/pull/${pull.number}`;
      assert.equal(pull.html_url, expectedPullUrl);
      assert.ok(
        paired.some(
          (call) =>
            call.operations.includes("nativePr") &&
            call.completion.pullUrls.includes(expectedPullUrl),
        ),
        "the successful native gh pr create result must identify this authorized repository PR",
      );
      assert.equal(
        taskFailure,
        undefined,
        "task transport failed despite reconciled remote outcome",
      );
      await f.record("Model tools and independent provider readback agree", {
        sessionKey,
        taskSessionId: trace.sessionId,
        agentId: agent.id,
        revisionId: revision.id,
        podUid: gateway.metadata.uid,
        credentialSessionId: attempt.sessionId,
        commitSha,
        baseSha,
        branch,
        file,
        pullNumber: pull.number,
        toolCallIds: paired.map((call) => call.id),
      });
    } catch (error) {
      workFailure = error;
      throw error;
    } finally {
      if (agent) {
        try {
          await f.api(
            "POST",
            `/namespaces/${f.namespace.id}/agents/${agent.id}/stop`,
            undefined,
            202,
          );
          await f.waitFor("Agent stop, session disposal and material deletion", async () => {
            const current = await f.api("GET", `/namespaces/${f.namespace.id}/agents/${agent.id}`);
            const pods = await f.kubernetes.resources(
              "pods",
              f.tenant,
              "-l",
              `openclaw.dev/agent=${agent.id}`,
            );
            const materials = (
              await f.kubectl(
                "-n",
                f.tenant,
                "get",
                "secrets",
                "-l",
                `openclaw.dev/agent=${agent.id},openclaw.dev/repository-material=session`,
                "-o",
                "jsonpath={.items[*].metadata.name}",
              )
            ).trim();
            const pending = await f.sql(
              `SELECT count(*) FROM occ.repository_session_attempts WHERE namespace_id=${sqlLiteral(f.namespace.id)} AND agent_id=${sqlLiteral(agent.id)} AND phase IN ('opening','open','closing');`,
            );
            return (
              current.desiredRuntimeState === "stopped" &&
              !current.activeRevisionId &&
              pods.length === 0 &&
              materials.length === 0 &&
              pending === "0"
            );
          });
          if (attempt) {
            const disposed = await readInstalledCredentialSession(f, workerPod, attempt.sessionId);
            assert.equal(disposed.sessionId, attempt.sessionId);
            assert.equal(disposed.state, "DISPOSED");
            assert.equal(disposed.activeUses, 0);
            assert.equal(disposed.cleanup.active, 0);
            assert.equal(disposed.cleanup.pending, 0);
            assert.equal(disposed.cleanup.uncertain, 0);
            assert.equal(disposed.cleanup.auxiliaryPending, false);
          }
          agentStopped = true;
          await f.record("Ordinary Agent stop disposed sessions and removed runtime material", {
            agentId: agent.id,
          });
        } catch {
          cleanupFailures.push("Agent stop or session/material cleanup unresolved");
        }
      }
      if (taskStarted && !agentStopped)
        cleanupFailures.push("remote cleanup requires confirmed stopped Agent");
      if (taskStarted && agentStopped) {
        try {
          const { data: matches } = await observe(
            "GET",
            `pulls?state=all&head=${encodeURIComponent(repository.split("/")[0] + ":" + branch)}&per_page=100`,
          );
          const reference = await observe("GET", `git/ref/heads/${branch}`, undefined, [200, 404]);
          if (reference.status === 200) {
            const sha = reference.data.object.sha;
            const { data: commit } = await observe("GET", `commits/${sha}`);
            assert.deepEqual(
              commit.parents.map((p) => p.sha),
              [baseSha],
            );
            assert.equal(commit.commit.message, `Installed credential proof ${f.suffix}`);
            assert.deepEqual(
              commit.files.map((value) => ({ filename: value.filename, status: value.status })),
              [{ filename: file, status: "added" }],
            );
            const { data: ownedFile } = await observe("GET", `contents/${file}?ref=${sha}`);
            assert.equal(Buffer.from(ownedFile.content, "base64").toString("utf8"), content);
            if (remoteEvidence)
              assert.equal(
                sha,
                remoteEvidence.commitSha,
                "changed branch cannot be cleaned automatically",
              );
            assert.ok(matches.length <= 1, "ambiguous PR ownership");
            for (const pull of matches) {
              assert.equal(pull.body, marker);
              assert.equal(pull.head.ref, branch);
              assert.equal(pull.head.sha, sha);
              assert.equal(pull.head.repo.id, Number(app.repositoryId));
              assert.equal(pull.base.ref, base);
              const { data: current } = await observe("GET", `pulls/${pull.number}`);
              assert.equal(current.head.sha, sha);
              assert.equal(current.body, marker);
              if (current.state === "open")
                await observe("PATCH", `pulls/${pull.number}`, { state: "closed" });
              assert.equal((await observe("GET", `pulls/${pull.number}`)).data.state, "closed");
            }
            assert.equal((await observe("GET", `git/ref/heads/${branch}`)).data.object.sha, sha);
            await observe("DELETE", `git/refs/heads/${branch}`, undefined, 204);
            await observe("GET", `git/ref/heads/${branch}`, undefined, 404);
          } else assert.equal(matches.length, 0, "PR remains after branch disappeared");
          await f.record("Run-owned remote PR and unchanged branch reconciled and removed");
        } catch {
          cleanupFailures.push("remote ownership or cleanup unresolved");
        }
      }
      if (cleanupFailures.length)
        throw new AggregateError(
          [
            ...(workFailure ? [workFailure] : []),
            ...cleanupFailures.map((message) => new Error(message)),
          ],
          "cleanup must finish before installed acceptance can pass",
        );
    }
  },
);
