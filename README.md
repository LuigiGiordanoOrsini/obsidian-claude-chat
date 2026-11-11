# Claude Chat for Obsidian

An Obsidian side panel with a [Claude Code](https://claude.com/claude-code) conversation that works directly on the notes of your vault, much like the Claude Code extension does for VS Code.

> Unofficial plugin: it is not developed or endorsed by Anthropic or Obsidian.

## What it does

- **Claude button** in the left ribbon: opens the chat panel on the right.
- **Agent on your vault**: Claude Code starts in the vault folder, so it reads and edits your notes and follows `CLAUDE.md`, if the vault has one.
- **Automatic context**: the open note and any selected text are passed to Claude.
- **Permissions**: when an authorization is needed, a card appears with Allow / Always allow / Deny.
- **Model picker**: choose the model (Default, Fable, Opus, Sonnet, Haiku) from the chat panel. Switching model keeps the current conversation.
- **History**: conversations are saved and can be reopened and continued from the history button.
- **Streaming answers**, rendered as Obsidian Markdown; files Claude touched are clickable links.

## Requirements

- Obsidian desktop (the plugin does not work on mobile).
- Claude Code installed and already signed in. The plugin looks for it automatically:
  - in the Claude desktop app for Windows,
  - in the Claude Code extension for VS Code,
  - on the system `PATH`.

  If it is not found, set the path to the executable in the plugin settings.
- Tested on Windows only. On macOS and Linux it should work if `claude` is on the `PATH`, but this has not been tried.

## Installation

### With BRAT

1. Install the **BRAT** community plugin.
2. In BRAT choose "Add beta plugin" and paste `LuigiGiordanoOrsini/obsidian-claude-chat`.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/LuigiGiordanoOrsini/obsidian-claude-chat/releases).
2. Copy them into `<vault>/.obsidian/plugins/claude-chat/`.
3. Restart Obsidian and enable "Claude Chat" in Settings → Community plugins.

## Usage

- Enter sends the message, Shift+Enter adds a new line.
- "Stop" interrupts the work in progress; your next message resumes the same conversation.
- "+" starts a new conversation.
- "×" closes the panel; the Claude button in the ribbon opens it again. The conversation stays in the history.
- The clock icon opens the history: click a conversation to reopen it, or the bin to remove it.

## Access level

In Settings → Claude Chat, choose what Claude may do without asking:

| Level | Behaviour |
|---|---|
| Edits notes, asks before commands (default) | Reads and writes files; asks before running system commands. |
| Asks before every edit | Also asks before writing a file. |
| Read-only | Reads and plans, changes nothing. |
| Full access, never asks | No permission prompts. Use it only if you understand what that implies. |

## Known limits

- No diff preview before an edit.
- The history keeps the 50 most recent conversations, stored in the plugin's `data.json` inside the vault.
- A conversation can only be continued while Claude Code still has its session on this computer; otherwise the transcript stays readable and the next message starts a fresh session.

## Privacy

The plugin sends nothing on its own: it starts Claude Code on your computer, which talks to Anthropic with your account. The notes Claude reads become part of that conversation. Saved conversations stay in your vault.

## License

[MIT](LICENSE)
