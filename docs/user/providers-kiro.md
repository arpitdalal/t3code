# Kiro

T3 Code runs the [Kiro CLI](https://kiro.dev/docs/cli/) as an agent, using your own Kiro account,
custom agents, steering, and MCP configuration.

## Set Up Kiro

1. Install the Kiro CLI on the machine running the T3 Code server
   (`curl -fsSL https://cli.kiro.dev/install | bash`).
2. Run `kiro-cli login` once in a terminal. Kiro Pro and higher plans can instead set an API key as
   `KIRO_API_KEY` in the Kiro provider's environment variables.
3. Open **Settings → Providers**, enable Kiro, and refresh it.

If `kiro-cli` is not on the server's `PATH`, set its **Binary path**. The installer usually puts it
in `~/.local/bin`. T3 Code starts Kiro's CLI V3 engine, so a Kiro CLI that cannot run V3 will not
start.

## MCP servers

Kiro loads MCP servers from its own configuration on the server machine. OAuth MCP servers need a
separate sign-in in T3 Code, even if they already work in the Kiro terminal.

In **Settings → Providers → Kiro**, select the server's MCP sign-in method, choose **Connect MCP
server**, and open the sign-in page. Servers discovered in a project include its path in the method
name. T3 Code saves Kiro's MCP credentials for that provider instance, so new threads and server
restarts reuse them.

When connecting remotely, the browser may finish on an unreachable localhost URL. Paste that final
URL into the sign-in screen's **Final localhost URL** field to complete the connection on the server.

Connecting or forgetting MCP sign-ins stops running Kiro threads; their history is kept.
Settings > Providers > Kiro lists each MCP server's connection status. **Authentication required**
means Kiro needs a new sign-in; **Connection failed** means the connection failed for another reason.
Statuses update from Kiro sessions. Start a Kiro thread to check servers marked **Not checked**.
**Last check** shows the last result after its session closed, not a live connection.

**Forget MCP sign-ins** clears the instance's saved MCP credentials. Your Kiro account stays signed
in, and this does not revoke access at the external service.

## Models

The model picker lists the models your Kiro account can use once Kiro is signed in. **Kiro
default** lets Kiro choose (its `auto` model). A model your account cannot use stops the turn with
an error instead of running on another model.

Models with adjustable reasoning effort, such as recent Claude Opus and Sonnet models and GPT-5.6,
show a **Reasoning** setting with only the levels Kiro offers for that model. **Kiro default** and
models without effort control run at Kiro's own setting.

## Agents

The **Agent** setting next to the model picks the
[Kiro agent](https://kiro.dev/docs/custom-agents/) a thread runs as: Kiro's built-in agents such as
Spec and Plan, and your own agents in `~/.kiro/agents`. Agents in a project's `.kiro/agents` are
not listed yet. Refresh the Kiro provider after adding or removing an agent.

The thread's model still applies when an agent sets its own `model`. An agent that was removed
leaves the thread on Kiro's current agent.

Skills in `~/.kiro/skills` and the project's `.kiro/skills` appear in the skill picker.
Project skills override user skills with the same name.

The context meter shows Kiro's reported usage. Run `/compact` to compact the conversation;
T3 Code waits for Kiro to finish. Kiro servers that do not advertise compaction return an error.

## Permission Modes

Kiro asks before tool calls such as writes and commands, and T3 Code answers by the permission mode:

- **Supervised** sends those requests to you. Kiro's Autopilot is off, so Kiro also asks you to
  review the turn's file changes before it finishes.
- **Full access** approves them without asking you. Autopilot stays on, so there is no review step.

Kiro offers no **Auto** or **Auto-accept edits**. Approvals offer only the choices Kiro sends. Kiro's
"always allow" saves a rule for the whole workspace, so T3 Code does not offer it as a
session-wide choice.
