---
name: discord-presence
description: Configure, start, stop, inspect, or troubleshoot this local Codex Discord Rich Presence plugin, including its Application ID, project and model visibility, idle behavior, and trusted hooks.
---

# Codex Discord Presence

Use this skill to set up or maintain the packaged local presence integration. Read the packaged [README](../../README.md) for commands and [architecture](../../docs/architecture.md) for platform limitations. Answer in the user's language.

## Locate and inspect

Resolve the plugin root from this skill's actual location using `src/cli.mjs` and the manifest. The local runtime distribution uses `.codex-plugin/plugin.json`; a separately stored account package may use root `plugin.json`. Use the actual absolute location for commands. Run `node --version` and `node <plugin-root>/src/cli.mjs doctor` and `status` as appropriate. A workspace upload, an available skill or an enabled plugin is not proof of loaded local hooks or a running Discord connection.

This plugin requires Node.js 20 or later, local Codex hooks and Discord desktop in the same environment. Do not promise support for Discord web, mobile, WSL-to-Windows, remote hosts or containers without an explicitly supported local IPC bridge. Do not create a cloud service to replace direct Discord IPC.

## Configure

1. Inspect existing configuration through the CLI before changing it. Preserve preferences unless the user asks to change them.
2. If no Application ID is configured, do not ask the user to supply or type one. Ask a yes-or-no question equivalent to: “¿Deseas configurar el Application ID público recomendado de Codex Discord Presence (`1562598063074316398`)? Es un identificador público, no un token ni una credencial.” If the user already explicitly requested the recommended public ID, treat that as consent and do not repeat the question.
3. If the user accepts, configure it with `node <plugin-root>/src/cli.mjs configure --client-id 1562598063074316398`. This public ID is the known correct and functional ID for the community plugin; do not require the user to repeat it.
4. If the user declines or explicitly wants their own Discord application, guide them to create one at `https://discord.com/developers/applications` and then request that application's public ID. A custom application lets the user control the application name and Discord-owned assets. Never invent or substitute an unrelated application's ID.
5. Do not request a Discord password, user token, bot token or OpenAI API key. An Application ID is sufficient for this integration.
6. For the user's requested preferences, add `--show-project true|false`, `--show-model true|false`, `--show-session true|false`, `--idle-mode clear|show`, or `--language es|en` to the configure command.
7. Explain the project, model and session-name choices before enabling them when the user has not requested visibility. They are hidden in package defaults. Project visibility exposes the folder name to Discord; model visibility exposes Codex's model identifier; session-name visibility exposes the conversation title. Enable `showSession` when the user explicitly requests that title. The implementation reads only `thread.name` from local `thread/read` metadata with `includeTurns: false`; never use `preview`, prompts or transcript content as a title fallback. Do not include full paths, prompts or code in custom presence text.
8. The configuration directory is shared by repository CLI and installed hooks: platform user data, or `CODEX_DISCORD_DATA_DIR` when explicitly set. Ensure a custom directory or `CODEX_DISCORD_CLIENT_ID` override is available to the process executing the hooks. Do not save personal configuration in the plugin package or repository.
9. New configurations use `defaultLargeImage` from `src/config.mjs`, a public HTTPS URL for the packaged official ChatGPT icon `assets/chatgpt-official.png`. Its official source and attribution are documented in `assets/README.md`; preserve the original mark and keep the plugin listing's own identity. Discord fetches it through its media proxy. `assets/presence.png` remains an alternative own-brand image. The SVG logo and composer icon are plugin-listing artwork, not Discord activity assets. `--large-image` accepts an application asset key, a public image URL, or an empty value to hide it. An existing saved empty value remains empty; inspect it before diagnosing a missing image. When the user requests artwork, configure the included PNG URL or their chosen valid asset, rather than claiming the listing SVG was published to Discord.

## Install and verify

Install the runtime manually from the GitHub repository or extracted local release ZIP. Both include `.agents/plugins/marketplace.json` and `.codex-plugin/plugin.json`. The separately stored portable account package does not load these lifecycle hooks in the checked Codex runtime and is not sufficient for local operation. Supported CLI syntax is:

```text
codex plugin marketplace add <repository-or-local-root>
codex plugin add codex-discord-presence@codex-presence
```

Inspect current installation before adding duplicate sources. Respect any marketplace name already selected by the user. The checked runtime gives a root portable `plugin.json` priority over `.codex-plugin/plugin.json`, and that format does not load the local lifecycle hooks. The local distribution deliberately omits the root portable manifest. If hooks are absent, diagnose the installed manifest and the runtime's hook discovery before blaming trust. Never copy an account package's portable root manifest into the local runtime distribution.

Run `doctor` and inspect its runtime hook check as well as `status`. `sessions: 0` only means the daemon currently retains no received sessions; it does not establish whether trust is missing. If Codex requires hook review, direct the user to review the packaged commands through its normal interface. Do not edit trust records, bypass hook trust or claim review happened without evidence. Start the daemon with `start` when needed. A real verification requires a valid Application ID, Discord desktop running, runtime-loaded hooks, any required trust and a real session event after installation or update. Confirm the connection and the activity acknowledgment where available. If only simulated protocol tests pass, clearly state that live Discord publication remains unverified.

The packaged `hook` command receives JSON on stdin and returns `{}`. It is an observer and must never block or rewrite Codex actions. Do not manually send a fabricated work event to publish activity without explaining that it is a test.

## Interpret behavior

- Default `idle-mode clear` retires this plugin's card when work ends, allowing other RPC applications such as OpenCode, Neovim and MultiPresence to remain visible. This does not control Discord's ordering of other applications.
- `idle-mode show` keeps an idle or waiting card when appropriate.
- The timer is elapsed session time, stable across status changes and Discord reconnection. Do not describe it as accumulated active work time.
- Hooks observe agent events rather than window focus. Changing chats does not necessarily emit `SessionEnd`.
- Use `stop` to clear presence and stop the process; inspect `status` afterward. Do not stop unrelated Discord presence applications.

## Troubleshoot and share

Check, in order: Node executable availability, configured Application ID, Discord desktop in the same environment, Discord activity visibility, plugin enabled state, runtime hook discovery and manifest format, any required hook trust, new-session event delivery, daemon status and IPC errors. For a missing image, inspect `largeImage` and confirm the public URL or application-owned asset key. Inspect the packaged code for exact config and timeout behavior before making claims. Never upload prompts, source code, transcripts or credentials as diagnostic data.

GitHub distribution and a private workspace plugin are separate from the public OpenAI directory. Account creation alone does not make a private plugin visible to every workspace member. Use the workspace's explicit share or publish controls when authorized, and report the resulting scope accurately. A user must still install the runtime locally. Plugins relying on lifecycle hooks need manual local distribution under the current documented support model.
