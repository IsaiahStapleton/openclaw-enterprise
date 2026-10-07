package occcli

import (
	"cmp"
	"context"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"github.com/spf13/cobra"
)

const defaultTimeoutSeconds = "30"

// outputFormatsAnnotation lists the -o values a command accepts; the first replaces
// the global "table" default.
const outputFormatsAnnotation = "occ/output-formats"

// Version is replaced with a release version when distribution packaging is added.
var Version = "dev"

type application struct {
	out            io.Writer
	url            string
	serviceKeyFile string
	caBundle       string
	timeoutSeconds string
	namespace      string
	output         string
	parsedTimeout  time.Duration
	ctx            context.Context
}

// New builds the OCC domain command tree.
func New(out, errOut io.Writer) *cobra.Command {
	app := &application{out: out}
	command := &cobra.Command{
		Use:           "occ",
		Short:         "Manage OpenClaw Control Plane resources",
		Version:       Version,
		SilenceErrors: true,
		SilenceUsage:  true,
		Args:          cobra.NoArgs,
		// Runnable like commandGroup, so cobra checks Args and rejects an unknown
		// command instead of printing help and exiting 0.
		RunE: func(command *cobra.Command, _ []string) error {
			return command.Help()
		},
		PersistentPreRunE: func(command *cobra.Command, _ []string) error {
			app.ctx = command.Context()
			if printsTextOnly(command) {
				return nil
			}
			return app.validateOptions(command)
		},
	}
	command.SetOut(out)
	command.SetErr(errOut)
	command.SetVersionTemplate("occ {{.Version}}\n")
	command.SetHelpFunc(helpWithOutputFormats(command.HelpFunc()))

	flags := command.PersistentFlags()
	flags.StringVar(&app.url, "url", os.Getenv("OCC_URL"), "OCC endpoint URL")
	flags.StringVar(
		&app.serviceKeyFile,
		"service-key-file",
		os.Getenv("OCC_SERVICE_KEY_FILE"),
		"Bootstrap or service-key response file",
	)
	flags.StringVar(
		&app.caBundle,
		"ca-bundle",
		os.Getenv("OCC_CA_BUNDLE"),
		"Additional PEM trust bundle for the OCC endpoint",
	)
	flags.StringVar(
		&app.timeoutSeconds,
		"timeout-seconds",
		cmp.Or(os.Getenv("OCC_TIMEOUT_SECONDS"), defaultTimeoutSeconds),
		"Request timeout in seconds",
	)
	flags.StringVar(
		&app.namespace,
		"namespace",
		os.Getenv("OCC_NAMESPACE"),
		"Namespace scope for Configuration, Secret, Preset, credential source, IAM, and Agent operations",
	)
	flags.StringVarP(&app.output, "output", "o", "table", "Output format: table, json, or yaml")

	command.AddCommand(
		app.installationCommand(),
		app.namespaceCommand(),
		app.iamCommand(),
		app.serviceKeyCommand(),
		app.configurationCommand(),
		app.secretCommand(),
		app.presetCommand(),
		app.credentialSourceCommand(),
		app.agentCommand(),
		developmentCommand(),
	)
	command.InitDefaultHelpCmd()
	for _, child := range command.Commands() {
		if child.Name() == "help" {
			child.Run, child.RunE = nil, helpTopic
		}
	}
	return command
}

func (app *application) installationCommand() *cobra.Command {
	command := commandGroup("installation", "Inspect the singleton Installation")
	get := &cobra.Command{
		Use:   "get",
		Short: "Show the Installation",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			installation, err := client.GetInstallation()
			if err != nil {
				return err
			}
			return app.printItems(installation, false, []column{
				{title: "ID", key: "id"},
				{title: "NAME", key: "name"},
				{title: "CREATED", key: "createdAt"},
			})
		},
	}
	deploymentInventory := &cobra.Command{
		Use:   "deployment-inventory",
		Short: "Show the complete authorized Agent deployment inventory",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			result, err := client.GetInstallationDeploymentInventory()
			if err != nil {
				return err
			}
			return app.printItems(result, false, []column{
				{title: "INSTALLATION", key: "installationId"},
				{title: "NAMESPACES", key: "namespaces"},
			})
		},
	}
	command.AddCommand(get, deploymentInventory)
	return command
}

func (app *application) namespaceCommand() *cobra.Command {
	command := commandGroup("namespace", "Manage Namespaces")

	var existingNamespace string
	create := &cobra.Command{
		Use:   "create NAME",
		Short: "Create a Namespace",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			namespace, err := client.CreateNamespace(args[0], existingNamespace)
			if err != nil {
				return err
			}
			return app.printNamespace(namespace, false)
		},
	}
	create.Flags().StringVar(
		&existingNamespace,
		"existing-namespace",
		"",
		"Adopt this existing Kubernetes namespace",
	)

	list := &cobra.Command{
		Use:   "list",
		Short: "List authorized Namespaces",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			namespaces, err := client.ListNamespaces()
			if err != nil {
				return err
			}
			return app.printNamespace(namespaces, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Namespace",
		Args:  idArgs(namespaceIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			namespace, err := client.GetNamespace(args[0])
			if err != nil {
				return err
			}
			return app.printNamespace(namespace, false)
		},
	}

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Begin deleting an empty Namespace",
		Long: "Begin deleting an empty Namespace. A deleted Namespace's name stays reserved:\n" +
			"a new Namespace cannot reuse it.",
		Args: idArgs(namespaceIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			namespace, err := client.DeleteNamespace(args[0])
			if err != nil {
				return err
			}
			return app.printNamespace(namespace, false)
		},
	}

	command.AddCommand(create, list, get, deleteCommand)
	return command
}

func (app *application) iamCommand() *cobra.Command {
	command := commandGroup("iam", "Manage Namespace IAM policy")
	command.AddCommand(
		app.iamRoleCommand(),
		app.iamAccessBindingCommand(),
		app.iamServicePrincipalCommand(),
	)
	return command
}

func (app *application) iamServicePrincipalCommand() *cobra.Command {
	command := commandGroup("service-principal", "Manage Namespace ServicePrincipals for automation and CLI keys")

	create := &cobra.Command{
		Use:     "create",
		Short:   "Create a Namespace ServicePrincipal with no grants",
		Example: iamServicePrincipalCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			principal, err := client.CreateIAMServicePrincipal(namespace)
			if err != nil {
				return err
			}
			return app.printIAMServicePrincipal(principal, false)
		},
	}

	list := &cobra.Command{
		Use:   "list",
		Short: "List Namespace ServicePrincipals",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			principals, err := client.ListIAMServicePrincipals(namespace)
			if err != nil {
				return err
			}
			return app.printIAMServicePrincipal(principals, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Namespace ServicePrincipal",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			principal, err := client.GetIAMServicePrincipal(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printIAMServicePrincipal(principal, false)
		},
	}

	command.AddCommand(create, list, get)
	return command
}

func (app *application) serviceKeyCommand() *cobra.Command {
	command := commandGroup("service-key", "Issue and revoke service keys")

	var principalID, name, outFile string
	var expiresInDays int
	create := &cobra.Command{
		Use:     "create",
		Short:   "Issue a key for a ServicePrincipal and write it to a new key file",
		Example: serviceKeyCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			if expiresInDays != 0 && (expiresInDays < 1 || expiresInDays > 365) {
				return fmt.Errorf("--expires-in-days must be between 1 and 365")
			}
			if app.namespace != "" {
				if err := namespaceIDArg.check(app.namespace); err != nil {
					return fmt.Errorf("OCC_NAMESPACE or --namespace: %w", err)
				}
			}
			// Create the file first, so an existing path or a bad directory fails
			// before a key exists that nothing could save.
			file, err := os.OpenFile(outFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return fmt.Errorf("failed to create key file: %w", err)
			}
			written := false
			defer func() {
				_ = file.Close()
				if !written {
					_ = os.Remove(outFile)
				}
			}()
			client, err := app.client()
			if err != nil {
				return err
			}
			body := map[string]any{"servicePrincipalId": principalID, "name": name}
			if app.namespace != "" {
				body["namespaceId"] = app.namespace
			}
			if expiresInDays != 0 {
				body["expiresIn"] = expiresInDays * 24 * 60 * 60
			}
			key, err := client.CreateServiceKey(body)
			if err != nil {
				return err
			}
			details, ok := key.(map[string]any)
			keyID, _ := details["id"].(string)
			if !ok || keyID == "" {
				return fmt.Errorf("OCC returned an invalid service key")
			}
			// The file holds the issuance envelope, which --service-key-file reads.
			writeErr := json.MarshalWrite(file, map[string]any{"data": key})
			if writeErr == nil {
				writeErr = file.Close()
			}
			if writeErr != nil {
				// Nobody holds the unsaved key: revoke it, and name it if that fails too.
				if _, revokeErr := client.RevokeServiceKey(keyID); revokeErr != nil {
					return fmt.Errorf(
						"failed to write key file (%w); revoke unsaved service key %s with occ service-key revoke",
						writeErr,
						keyID,
					)
				}
				return fmt.Errorf("failed to write key file (%w); the unsaved service key %s was revoked", writeErr, keyID)
			}
			written = true
			delete(details, "key")
			return app.printServiceKey(details)
		},
	}
	create.Flags().StringVar(&principalID, "service-principal", "", "ServicePrincipal ID")
	create.Flags().StringVar(&name, "name", "", "Key name (1-32 characters)")
	create.Flags().StringVar(&outFile, "out", "", "New key file to write (mode 0600; must not exist)")
	create.Flags().IntVar(&expiresInDays, "expires-in-days", 0, "Lifetime in days, 1-365 (default 30)")
	_ = create.MarkFlagRequired("service-principal")
	_ = create.MarkFlagRequired("name")
	_ = create.MarkFlagRequired("out")

	revoke := &cobra.Command{
		Use:   "revoke ID",
		Short: "Revoke a service key",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			client, err := app.client()
			if err != nil {
				return err
			}
			result, err := client.RevokeServiceKey(args[0])
			if err != nil {
				return err
			}
			return app.printItems(result, false, []column{
				{title: "ID", key: "id"},
				{title: "REVOKED", key: "revoked"},
			})
		},
	}

	command.AddCommand(create, revoke)
	return command
}

func (app *application) iamRoleCommand() *cobra.Command {
	command := commandGroup("role", "Manage Namespace IAM Roles")

	var createFile string
	create := &cobra.Command{
		Use:     "create",
		Short:   "Create a Namespace IAM Role from a JSON document",
		Example: iamRoleCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, body, client, err := app.namespaceJSONClient(createFile)
			if err != nil {
				return err
			}
			role, err := client.CreateIAMRole(namespace, body)
			if err != nil {
				return err
			}
			return app.printIAMRole(role, false)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	list := &cobra.Command{
		Use:   "list",
		Short: "List Namespace IAM Roles",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			roles, err := client.ListIAMRoles(namespace)
			if err != nil {
				return err
			}
			return app.printIAMRole(roles, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Namespace IAM Role",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			role, err := client.GetIAMRole(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printIAMRole(role, false)
		},
	}

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete an unreferenced Namespace IAM Role",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			if err := client.DeleteIAMRole(namespace, args[0]); err != nil {
				return err
			}
			return app.printDeletion("iam role", args[0])
		},
	}

	command.AddCommand(create, list, get, deleteCommand)
	return command
}

func (app *application) iamAccessBindingCommand() *cobra.Command {
	command := commandGroup("access-binding", "Manage Namespace IAM AccessBindings")

	var createFile string
	create := &cobra.Command{
		Use:     "create",
		Short:   "Create a Namespace IAM AccessBinding from a JSON document",
		Example: iamAccessBindingCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, body, client, err := app.namespaceJSONClient(createFile)
			if err != nil {
				return err
			}
			binding, err := client.CreateIAMAccessBinding(namespace, body)
			if err != nil {
				return err
			}
			return app.printIAMAccessBinding(binding, false)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	list := &cobra.Command{
		Use:   "list",
		Short: "List Namespace IAM AccessBindings",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			bindings, err := client.ListIAMAccessBindings(namespace)
			if err != nil {
				return err
			}
			return app.printIAMAccessBinding(bindings, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Namespace IAM AccessBinding",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			binding, err := client.GetIAMAccessBinding(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printIAMAccessBinding(binding, false)
		},
	}

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete a Namespace IAM AccessBinding",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			if err := client.DeleteIAMAccessBinding(namespace, args[0]); err != nil {
				return err
			}
			return app.printDeletion("iam access-binding", args[0])
		},
	}

	command.AddCommand(create, list, get, deleteCommand)
	return command
}

func (app *application) configurationCommand() *cobra.Command {
	command := commandGroup("configuration", "Manage Configurations in the selected Namespace")

	var createFile string
	create := &cobra.Command{
		Use:     "create",
		Short:   "Create a Configuration from a JSON document",
		Example: configurationCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, body, client, err := app.namespaceJSONClient(createFile)
			if err != nil {
				return err
			}
			configuration, err := client.CreateConfiguration(namespace, body)
			if err != nil {
				return err
			}
			return app.printConfiguration(configuration)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Configuration",
		Args:  idArgs(configurationIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			configuration, err := client.GetConfiguration(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printConfiguration(configuration)
		},
	}

	var updateFile string
	update := &cobra.Command{
		Use:   "update ID",
		Short: "Update a Configuration from a JSON document",
		Args:  idArgs(configurationIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, body, client, err := app.namespaceJSONClient(updateFile)
			if err != nil {
				return err
			}
			configuration, err := client.UpdateConfiguration(namespace, args[0], body)
			if err != nil {
				return err
			}
			return app.printConfiguration(configuration)
		},
	}
	update.Flags().StringVar(&updateFile, "file", "", "JSON document path")
	_ = update.MarkFlagRequired("file")

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete an unreferenced Configuration",
		Args:  idArgs(configurationIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			if err := client.DeleteConfiguration(namespace, args[0]); err != nil {
				return err
			}
			return app.printDeletion("configuration", args[0])
		},
	}

	command.AddCommand(create, get, update, deleteCommand)
	return command
}

func (app *application) secretCommand() *cobra.Command {
	command := commandGroup("secret", "Manage Secrets in the selected Namespace")

	var createFile string
	create := &cobra.Command{
		Use:     "create",
		Short:   "Create a Secret from a JSON document",
		Example: secretCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, body, client, err := app.namespaceJSONClient(createFile)
			if err != nil {
				return err
			}
			secret, err := client.CreateSecret(namespace, body)
			if err != nil {
				return err
			}
			return app.printSecret(secret, false)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show Secret metadata and the resources that reference it",
		Args:  idArgs(secretIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			secret, err := client.GetSecret(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printSecretDetail(secret)
		},
	}

	var updateFile string
	update := &cobra.Command{
		Use:   "update ID",
		Short: "Update a Secret from a JSON document",
		Args:  idArgs(secretIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, body, client, err := app.namespaceJSONClient(updateFile)
			if err != nil {
				return err
			}
			secret, err := client.UpdateSecret(namespace, args[0], body)
			if err != nil {
				return err
			}
			return app.printSecret(secret, false)
		},
	}
	update.Flags().StringVar(&updateFile, "file", "", "JSON document path")
	_ = update.MarkFlagRequired("file")

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete an unbound Secret",
		Args:  idArgs(secretIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			if err := client.DeleteSecret(namespace, args[0]); err != nil {
				return err
			}
			return app.printDeletion("secret", args[0])
		},
	}

	list := &cobra.Command{
		Use:   "list",
		Short: "List Secret metadata",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			secrets, err := client.ListSecrets(namespace)
			if err != nil {
				return err
			}
			return app.printSecret(secrets, true)
		},
	}

	command.AddCommand(create, list, get, update, deleteCommand)
	return command
}

func (app *application) presetCommand() *cobra.Command {
	command := commandGroup("preset", "Manage Agent Presets in the selected Namespace")

	list := &cobra.Command{
		Use:   "list",
		Short: "List readable Presets",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			presets, err := client.ListPresets(namespace)
			if err != nil {
				return err
			}
			return app.printPreset(presets, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a Preset; -o json or -o yaml includes its template",
		Args:  idArgs(presetIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			preset, err := client.GetPreset(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printPreset(preset, false)
		},
	}

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete a Preset; Agents and Configurations created from it are unchanged",
		Args:  idArgs(presetIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			if err := client.DeletePreset(namespace, args[0]); err != nil {
				return err
			}
			return app.printDeletion("preset", args[0])
		},
	}

	command.AddCommand(list, get, deleteCommand)
	return command
}

func (app *application) credentialSourceCommand() *cobra.Command {
	command := commandGroup(
		"credential-source",
		"Manage credential sources held by the selected Credential Gateway",
	)

	var createFile string
	create := &cobra.Command{
		Use:     "create",
		Short:   "Register a credential source from a JSON document",
		Example: credentialSourceCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, body, client, err := app.namespaceJSONClient(createFile)
			if err != nil {
				return err
			}
			source, err := client.CreateCredentialSource(namespace, body)
			if err != nil {
				return err
			}
			return app.printCredentialSource(source, false)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	list := &cobra.Command{
		Use:   "list",
		Short: "List credential sources without live gateway status",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			sources, err := client.ListCredentialSources(namespace)
			if err != nil {
				return err
			}
			return app.printCredentialSource(sources, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show a credential source and its live gateway status",
		Args:  idArgs(credentialSourceIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			source, err := client.GetCredentialSource(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printCredentialSource(source, false)
		},
	}

	deleteCommand := &cobra.Command{
		Use:   "delete ID",
		Short: "Delete an unreferenced credential source and its gateway copy",
		Args:  idArgs(credentialSourceIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			if err := client.DeleteCredentialSource(namespace, args[0]); err != nil {
				return err
			}
			return app.printDeletion("credential-source", args[0])
		},
	}

	var updateFile string
	update := &cobra.Command{
		Use:   "update ID",
		Short: "Push current or replacement Secret values to the gateway copy",
		Args:  idArgs(credentialSourceIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			body := jsontext.Value("{}")
			if updateFile != "" {
				body, err = readJSON(updateFile)
				if err != nil {
					return err
				}
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			source, err := client.UpdateCredentialSource(namespace, args[0], body)
			if err != nil {
				return err
			}
			return app.printCredentialSource(source, false)
		},
	}
	update.Flags().StringVar(
		&updateFile,
		"file",
		"",
		"JSON document with replacement secrets; omit to re-send the current Secret values",
	)

	command.AddCommand(create, list, get, update, deleteCommand)
	return command
}

func (app *application) agentCommand() *cobra.Command {
	command := commandGroup("agent", "Manage Agents in the selected Namespace")

	var createFile string
	create := &cobra.Command{
		Use:     "create",
		Short:   "Create an Agent from a JSON document",
		Example: agentCreateExample,
		Args:    cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, body, client, err := app.namespaceJSONClient(createFile)
			if err != nil {
				return err
			}
			agent, err := client.CreateAgent(namespace, body)
			if err != nil {
				return err
			}
			return app.printAgent(agent, false)
		},
	}
	create.Flags().StringVar(&createFile, "file", "", "JSON document path")
	_ = create.MarkFlagRequired("file")

	list := &cobra.Command{
		Use:   "list",
		Short: "List Agents",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			agents, err := client.ListAgents(namespace)
			if err != nil {
				return err
			}
			return app.printAgent(agents, true)
		},
	}

	get := &cobra.Command{
		Use:   "get ID",
		Short: "Show an Agent",
		Args:  idArgs(agentIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			agent, err := client.GetAgent(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printAgent(agent, false)
		},
	}

	var updateFile string
	update := &cobra.Command{
		Use:   "update ID",
		Short: "Update an Agent from a JSON document",
		Args:  idArgs(agentIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, body, client, err := app.namespaceJSONClient(updateFile)
			if err != nil {
				return err
			}
			agent, err := client.UpdateAgent(namespace, args[0], body)
			if err != nil {
				return err
			}
			return app.printAgent(agent, false)
		},
	}
	update.Flags().StringVar(&updateFile, "file", "", "JSON document path")
	_ = update.MarkFlagRequired("file")

	deploy := &cobra.Command{
		Use:   "deploy ID",
		Short: "Deploy an Agent and create an immutable revision",
		Args:  idArgs(agentIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, err := app.requiredNamespace()
			if err != nil {
				return err
			}
			client, err := app.client()
			if err != nil {
				return err
			}
			revision, err := client.DeployAgent(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printItems(revision, false, []column{
				{title: "ID", key: "id"},
				{title: "REVISION", key: "revision"},
				{title: "AGENT", key: "agentId"},
				{title: "CONFIGURATION", key: "configurationId"},
			})
		},
	}
	revisions := &cobra.Command{
		Use:   "revisions AGENT_ID",
		Short: "List an Agent's immutable revisions (deployment IDs)",
		Args:  idArgs(agentIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			result, err := client.ListAgentRevisions(namespace, args[0])
			if err != nil {
				return err
			}
			rows, err := describeAgentRevisions(client, namespace, args[0], result)
			if err != nil {
				return err
			}
			return app.printAgentRevisionList(rows)
		},
	}
	deploymentStatus := &cobra.Command{
		Use:   "deployment-status AGENT_ID [DEPLOYMENT_ID]",
		Short: "Show durable status for one Agent deployment, by default the latest revision",
		Args:  idArgs(agentIDArg, optionalID(revisionIDArg)),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			var deploymentID string
			if len(args) == 2 {
				deploymentID = args[1]
			} else {
				result, err := client.ListAgentRevisions(namespace, args[0])
				if err != nil {
					return err
				}
				if deploymentID, err = latestRevisionID(args[0], result); err != nil {
					return err
				}
			}
			deployment, err := client.GetAgentDeployment(namespace, args[0], deploymentID)
			if err != nil {
				return err
			}
			return app.printDeploymentStatus(deployment)
		},
	}
	stop := &cobra.Command{
		Use:   "stop ID",
		Short: "Stop an Agent while retaining its revision history and persistent state",
		Long: "Stop an Agent while retaining its revision history and persistent state.\n" +
			"The stop is asynchronous: the Agent's runtime shuts down in the background.\n" +
			"There is no start command; run \"occ agent deploy ID\" to start the Agent again with a new revision.",
		Args: idArgs(agentIDArg),
		RunE: func(command *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			agent, err := client.StopAgent(namespace, args[0])
			if err != nil {
				return err
			}
			if err := app.printAgent(agent, false); err != nil {
				return err
			}
			fmt.Fprintf(command.ErrOrStderr(), "notice: stop requested; run \"occ agent deploy %s\" to start the Agent again\n", args[0])
			return nil
		},
	}
	deleteAgent := &cobra.Command{
		Use:   "delete ID",
		Short: "Begin asynchronous Agent deletion",
		Args:  idArgs(agentIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			agent, err := client.DeleteAgent(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printAgent(agent, false)
		},
	}

	command.AddCommand(
		create,
		list,
		get,
		update,
		deploy,
		revisions,
		deploymentStatus,
		stop,
		deleteAgent,
		app.agentRuntimeCredentialsCommand(),
		app.agentCredentialWithdrawalCommand(),
		app.agentRuntimeCommand(),
		app.agentLogsCommand(),
	)
	return command
}

// describeAgentRevisions adds what tells revisions apart to each listed
// revision: whether it is the Agent's active revision and the status of the
// deployment that created it. A revision whose deployment status the caller may
// not read, or that OCC no longer records, gets a null deploymentStatus.
func describeAgentRevisions(client *occclient.Client, namespace, agentID string, value any) ([]any, error) {
	revisions, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("OCC returned an invalid resource collection")
	}
	agent, err := client.GetAgent(namespace, agentID)
	if err != nil {
		return nil, err
	}
	resource, _ := agent.(map[string]any)
	activeID, _ := resource["activeRevisionId"].(string)
	rows := make([]any, 0, len(revisions))
	for _, item := range revisions {
		revision, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("OCC returned an invalid resource")
		}
		row := maps.Clone(revision)
		id, _ := revision["id"].(string)
		row["active"] = id != "" && id == activeID
		row["deploymentStatus"] = nil
		if id != "" {
			deployment, err := client.GetAgentDeployment(namespace, agentID, id)
			var apiErr *occclient.APIError
			switch {
			case err == nil:
				if status, ok := deployment.(map[string]any); ok {
					row["deploymentStatus"] = status["status"]
				}
			case errors.As(err, &apiErr) && (apiErr.Status == http.StatusNotFound || apiErr.Status == http.StatusForbidden):
			default:
				return nil, err
			}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func (app *application) agentCredentialWithdrawalCommand() *cobra.Command {
	command := commandGroup(
		"credential-withdrawal",
		"Revoke a credential source from an Agent's active revision",
	)

	request := &cobra.Command{
		Use:   "request AGENT_ID SOURCE_ID",
		Short: "Request revocation; the worker revokes it from the running revision",
		Args:  idArgs(agentIDArg, credentialSourceIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			withdrawal, err := client.WithdrawAgentCredentialSource(namespace, args[0], args[1])
			if err != nil {
				return err
			}
			return app.printCredentialWithdrawal(withdrawal)
		},
	}

	get := &cobra.Command{
		Use:   "get AGENT_ID SOURCE_ID",
		Short: "Show whether the source is revoked and why a revocation is still pending",
		Args:  idArgs(agentIDArg, credentialSourceIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			found, err := client.GetAgentCredentialWithdrawal(namespace, args[0], args[1])
			if err != nil {
				return err
			}
			return app.printCredentialWithdrawal(found)
		},
	}

	command.AddCommand(request, get)
	return command
}

func (app *application) agentRuntimeCredentialsCommand() *cobra.Command {
	command := commandGroup("runtime-credentials", "Manage generated Agent runtime credentials")

	get := &cobra.Command{
		Use:   "get AGENT_ID",
		Short: "Show runtime credential metadata",
		Args:  idArgs(agentIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			credentials, err := client.GetAgentRuntimeCredentials(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printRuntimeCredentials(credentials)
		},
	}

	provision := &cobra.Command{
		Use:   "provision AGENT_ID",
		Short: "Provision initial runtime credentials with an empty request body",
		Args:  idArgs(agentIDArg),
		RunE: func(_ *cobra.Command, args []string) error {
			namespace, client, err := app.namespaceClient()
			if err != nil {
				return err
			}
			credentials, err := client.ProvisionAgentRuntimeCredentials(namespace, args[0])
			if err != nil {
				return err
			}
			return app.printRuntimeCredentials(credentials)
		},
	}

	command.AddCommand(get, provision)
	return command
}

// helpOnlyAnnotation marks a command whose only action is printing its help.
const helpOnlyAnnotation = "occ/help-only"

func commandGroup(use, short string) *cobra.Command {
	return &cobra.Command{
		Use:         use,
		Short:       short,
		Args:        cobra.NoArgs,
		Annotations: map[string]string{helpOnlyAnnotation: "true"},
		RunE: func(command *cobra.Command, _ []string) error {
			return command.Help()
		},
	}
}

// printsTextOnly reports commands that never call OCC: the root and command
// groups, which print their help, the help command, and shell completion. An
// invalid OCC_TIMEOUT_SECONDS or -o must not stop them.
func printsTextOnly(command *cobra.Command) bool {
	if !command.HasParent() || command.Annotations[helpOnlyAnnotation] != "" {
		return true
	}
	if command.Parent() != command.Root() {
		// Cobra's "completion bash" and its siblings.
		return command.Parent().Name() == "completion" && command.Parent().Parent() == command.Root()
	}
	switch command.Name() {
	case "help", "completion", cobra.ShellCompRequestCmd, cobra.ShellCompNoDescRequestCmd:
		return true
	}
	return false
}

// helpTopic is the help command's action. Cobra's own prints the closest
// command's help and exits 0 for a mistyped topic; this one fails instead.
func helpTopic(command *cobra.Command, args []string) error {
	target, rest, err := command.Root().Find(args)
	if err != nil {
		return err
	}
	if len(rest) > 0 {
		message := fmt.Sprintf("unknown help topic %q", strings.Join(args, " "))
		if target.SuggestionsMinimumDistance <= 0 {
			target.SuggestionsMinimumDistance = 2 // cobra's default for unknown commands
		}
		if suggestions := target.SuggestionsFor(rest[0]); len(suggestions) > 0 {
			topic := append(strings.Fields(target.CommandPath())[1:], suggestions[0])
			return fmt.Errorf("%s; did you mean %q?", message, strings.Join(topic, " "))
		}
		return fmt.Errorf("%s; run \"occ help\" for the command list", message)
	}
	if target.Context() == nil {
		target.SetContext(command.Context())
	}
	target.InitDefaultHelpFlag()
	target.InitDefaultVersionFlag()
	return target.Help()
}

// helpWithOutputFormats makes help for a command with its own -o formats (see
// outputFormatsAnnotation) describe those formats instead of the global ones.
func helpWithOutputFormats(help func(*cobra.Command, []string)) func(*cobra.Command, []string) {
	return func(command *cobra.Command, args []string) {
		annotated, ok := command.Annotations[outputFormatsAnnotation]
		flag := command.Root().PersistentFlags().Lookup("output")
		if !ok || flag == nil {
			help(command, args)
			return
		}
		formats := strings.Split(annotated, ",")
		usage, defValue := flag.Usage, flag.DefValue
		flag.Usage = "Output format: " + strings.Join(formats, ", ")
		flag.DefValue = formats[0]
		defer func() { flag.Usage, flag.DefValue = usage, defValue }()
		help(command, args)
	}
}

func (app *application) validateOptions(command *cobra.Command) error {
	formats := []string{"table", "json", "yaml"}
	if annotated, ok := command.Annotations[outputFormatsAnnotation]; ok {
		formats = strings.Split(annotated, ",")
		if app.output == "table" {
			app.output = formats[0]
		}
	}
	if !slices.Contains(formats, app.output) {
		return fmt.Errorf(
			"invalid output format %q: expected %s",
			app.output,
			strings.Join(formats, ", "),
		)
	}
	seconds, err := strconv.ParseUint(app.timeoutSeconds, 10, 64)
	if err != nil || seconds == 0 || seconds > uint64((1<<63-1)/int64(time.Second)) {
		return fmt.Errorf("OCC timeout must be a positive integer number of seconds")
	}
	app.parsedTimeout = time.Duration(seconds) * time.Second
	return nil
}

// Namespace and JSON errors must win over client configuration and key-file errors.
func (app *application) namespaceJSONClient(path string) (string, jsontext.Value, *occclient.Client, error) {
	namespace, err := app.requiredNamespace()
	if err != nil {
		return "", nil, nil, err
	}
	body, err := readJSON(path)
	if err != nil {
		return namespace, nil, nil, err
	}
	client, err := app.client()
	return namespace, body, client, err
}

// Invalid namespace input must win over client configuration and key-file errors.
func (app *application) namespaceClient() (string, *occclient.Client, error) {
	namespace, err := app.requiredNamespace()
	if err != nil {
		return "", nil, err
	}
	client, err := app.client()
	return namespace, client, err
}

func (app *application) client() (*occclient.Client, error) {
	if app.url == "" {
		return nil, fmt.Errorf("set OCC_URL or pass --url")
	}
	if app.serviceKeyFile == "" {
		return nil, fmt.Errorf("set OCC_SERVICE_KEY_FILE or pass --service-key-file")
	}
	return occclient.New(occclient.Config{
		URL:            app.url,
		ServiceKeyFile: app.serviceKeyFile,
		CABundle:       app.caBundle,
		Timeout:        app.parsedTimeout,
		Context:        app.ctx,
	})
}

func (app *application) requiredNamespace() (string, error) {
	if app.namespace == "" {
		return "", fmt.Errorf("set OCC_NAMESPACE or pass --namespace")
	}
	if err := namespaceIDArg.check(app.namespace); err != nil {
		return "", fmt.Errorf("OCC_NAMESPACE or --namespace: %w", err)
	}
	return app.namespace, nil
}

func readJSON(path string) (jsontext.Value, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read JSON file %s: %w", path, err)
	}
	value := jsontext.Value(contents)
	if !value.IsValid() {
		return nil, fmt.Errorf("invalid JSON file %s", path)
	}
	return value, nil
}
