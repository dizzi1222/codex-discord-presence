---
name: discord-presence
description: Configure, start, stop, inspect, or troubleshoot this local Codex Discord Rich Presence plugin, including its Application ID, project and model visibility, idle behavior, and trusted hooks.
---

# Codex Discord Presence

Use this skill to set up or maintain the packaged local presence integration. Read the packaged [README](../../README.md) for commands and [architecture](../../docs/architecture.md) for platform limitations. Answer in the user's language.

## Locate and inspect

Resolve the plugin root from this skill's actual location: it contains `plugin.json` and `src/cli.mjs`. Use that absolute location for all commands. Run `node --version` and `node <plugin-root>/src/cli.mjs status` or `doctor` as appropriate. A workspace upload is not proof of local installation or a running Discord connection.

This plugin requires Node.js 20 or later, local Codex hooks and Discord desktop in the same environment. Do not promise support for Discord web, mobile, WSL-to-Windows, remote hosts or containers without an explicitly supported local IPC bridge. Do not create a cloud service to replace direct Discord IPC.

## Configure

1. Inspect existing configuration through the CLI before changing it. Preserve preferences unless the user asks to change them.
2. If no Application ID is configured, ask for the user's Discord Application ID or guide them to create an application at `https://discord.com/developers/applications`. Explain that Discord uses that application's name as the title of the presence card. A name such as `Codex` needs an application with that name. Never invent or borrow an unrelated application's ID.
3. Do not request a Discord password, user token, bot token or OpenAI API key. The Application ID is sufficient for this integration.
4. Configure the application with `node <plugin-root>/src/cli.mjs configure --client-id <id>`. For the user's requested preferences, add `--show-project true|false`, `--show-model true|false`, `--idle-mode clear|show`, or `--language es|en`.
5. Explain the project and model choices before enabling them when the user has not requested visibility. They are hidden in package defaults. Project visibility exposes the folder name to Discord; model visibility exposes Codex's model identifier. Do not include full paths, conversation titles, prompts or code in custom presence text.
6. The configuration directory is shared by repository CLI and installed hooks: platform user data, or `CODEX_DISCORD_DATA_DIR` when explicitly set. Ensure a custom directory or `CODEX_DISCORD_CLIENT_ID` override is available to the process executing the hooks. Do not save personal configuration in the plugin package or repository.

## Install and verify

For source installation, the repository includes `.agents/plugins/marketplace.json`. Supported CLI syntax is:

```text
codex plugin marketplace add <repository-or-local-root>
codex plugin add codex-discord-presence@codex-presence
```

Inspect current installation before adding duplicate sources. Respect any marketplace name already selected by the user. Installing or enabling the plugin does not automatically trust its hooks. Direct the user to review the packaged hook commands and trust them using Codex's normal hook interface. Do not edit trust records, bypass hook trust or claim this review has happened without evidence.

Run `doctor` and inspect `status`. Start the daemon with `start` when needed. A real verification requires a valid Application ID, Discord desktop running, trusted hooks and a real session event. Confirm the connection and the activity acknowledgment where available. If only simulated protocol tests pass, clearly state that live Discord publication remains unverified.

The packaged `hook` command receives JSON on stdin and returns `{}`. It is an observer and must never block or rewrite Codex actions. Do not manually send a fabricated work event to publish activity without explaining that it is a test.

## Interpret behavior

- Default `idle-mode clear` retires this plugin's card when work ends, allowing other RPC applications such as OpenCode, Neovim and MultiPresence to remain visible. This does not control Discord's ordering of other applications.
- `idle-mode show` keeps an idle or waiting card when appropriate.
- The timer is elapsed session time, stable across status changes and Discord reconnection. Do not describe it as accumulated active work time.
- Hooks observe agent events rather than window focus. Changing chats does not necessarily emit `SessionEnd`.
- Use `stop` to clear presence and stop the process; inspect `status` afterward. Do not stop unrelated Discord presence applications.

## Troubleshoot and share

Check, in order: Node executable availability, configured Application ID, Discord desktop in the same environment, Discord activity visibility, plugin enabled state, hook trust, new-session event delivery, daemon status and IPC errors. Inspect the packaged code for exact config and timeout behavior before making claims. Never upload prompts, source code, transcripts or credentials as diagnostic data.

GitHub distribution and a private workspace plugin are separate from the public OpenAI directory. Account creation alone does not make a private plugin visible to every workspace member. Use the workspace's explicit share or publish controls when authorized, and report the resulting scope accurately. A user must still install the runtime locally. Plugins relying on lifecycle hooks need manual local distribution under the current documented support model.
