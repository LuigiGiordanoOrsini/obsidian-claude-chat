'use strict';

const obsidian = require('obsidian');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VIEW_TYPE = 'claude-chat-view';
const ICON_ID = 'claude-spark';
const ICON_SVG =
  '<g fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round">' +
  '<line x1="50" y1="8" x2="50" y2="92"/><line x1="8" y1="50" x2="92" y2="50"/>' +
  '<line x1="20" y1="20" x2="80" y2="80"/><line x1="80" y1="20" x2="20" y2="80"/></g>';

const MAX_CONVERSATIONS = 50;

const DEFAULT_SETTINGS = {
  claudePath: '',
  permissionMode: 'acceptEdits',
  model: '',
  includeActiveNote: true,
  conversations: [],
};

const PERMISSION_LABELS = {
  acceptEdits: 'Edits notes, asks before commands',
  default: 'Asks before every edit',
  plan: 'Read-only (plans, never edits)',
  bypassPermissions: 'Full access, never asks',
};

// Aliases understood by Claude Code; they follow the latest version of each model.
const MODEL_PRESETS = [
  ['', 'Default model'],
  ['fable', 'Fable'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];

/* ---------- Engine: find and run Claude Code ---------- */

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch (e) {
    return [];
  }
}

/** Looks for the Claude Code binary shipped with the Claude desktop app, the VS Code extension, or on PATH. */
function findClaude(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    for (const pkg of listDirs(path.join(local, 'Claude-Data'))) {
      for (const ver of listDirs(path.join(pkg, 'claude-code'))) {
        for (const build of listDirs(ver)) candidates.push(path.join(build, exe));
      }
    }
  }
  for (const ext of listDirs(path.join(os.homedir(), '.vscode', 'extensions'))) {
    if (path.basename(ext).startsWith('anthropic.claude-code-')) {
      candidates.push(path.join(ext, 'resources', 'native-binary', exe));
    }
  }
  candidates.push(path.join(os.homedir(), '.local', 'bin', exe));
  for (const p of (process.env.PATH || '').split(path.delimiter)) {
    if (p) candidates.push(path.join(p, exe));
  }
  let best = null;
  let bestTime = -1;
  for (const c of candidates) {
    try {
      const t = fs.statSync(c).mtimeMs;
      if (t > bestTime) {
        best = c;
        bestTime = t;
      }
    } catch (e) {
      /* does not exist */
    }
  }
  return best;
}

/**
 * Persistent Claude Code session (same protocol the VS Code extension uses:
 * JSON messages over stdin/stdout, permission prompts as control requests).
 * handlers: onInit(sessionId), onText(delta), onAssistant(blocks, streamed), onResult(msg),
 *           onPermission(request), onError(text), onClose(code)
 */
class ClaudeSession {
  constructor(opts, handlers) {
    this.opts = opts;
    this.handlers = handlers;
    this.child = null;
    this.buffer = '';
    this.stderr = '';
    this.streamed = false;
    this.initialized = false;
  }

  get alive() {
    return !!this.child;
  }

  start() {
    const o = this.opts;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool=stdio',
      '--permission-mode', o.permissionMode || 'acceptEdits',
      '--disallowed-tools', 'AskUserQuestion',
    ];
    if (o.model) args.push('--model', o.model);
    if (o.sessionId) args.push('--resume', o.sessionId);

    const child = spawn(o.claudePath, args, { cwd: o.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const h = this.handlers;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      h.onError && h.onError(String(err && err.message ? err.message : err));
    });
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (code && this.stderr.trim() && h.onError) h.onError(this.stderr.trim().slice(-800));
      h.onClose && h.onClose(code);
    });
  }

  handleLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      return;
    }
    const h = this.handlers;
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.initialized = true;
      h.onInit && h.onInit(msg.session_id);
    } else if (msg.type === 'stream_event') {
      if (msg.parent_tool_use_id) return; // sub-agent output: not shown
      const ev = msg.event || {};
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        this.streamed = true;
        h.onText && h.onText(ev.delta.text);
      }
    } else if (msg.type === 'assistant') {
      if (msg.parent_tool_use_id) return;
      const blocks = (msg.message && msg.message.content) || [];
      h.onAssistant && h.onAssistant(blocks, this.streamed);
      this.streamed = false;
    } else if (msg.type === 'result') {
      h.onResult && h.onResult(msg);
    } else if (msg.type === 'control_request') {
      const req = msg.request || {};
      if (req.subtype === 'can_use_tool') {
        h.onPermission &&
          h.onPermission({
            requestId: msg.request_id,
            toolName: req.display_name || req.tool_name,
            input: req.input || {},
            suggestions: req.permission_suggestions || [],
          });
      } else {
        this.write({
          type: 'control_response',
          response: { subtype: 'error', request_id: msg.request_id, error: 'Unsupported request: ' + req.subtype },
        });
      }
    }
  }

  write(obj) {
    if (this.child) this.child.stdin.write(JSON.stringify(obj) + '\n', 'utf8');
  }

  sendUser(text) {
    this.write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
  }

  /** decision: 'allow' | 'always' | 'deny' */
  respondPermission(request, decision) {
    let response;
    if (decision === 'deny') {
      response = { behavior: 'deny', message: 'The user denied this action.' };
    } else {
      response = { behavior: 'allow', updatedInput: request.input };
      if (decision === 'always' && request.suggestions.length) response.updatedPermissions = request.suggestions;
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: request.requestId, response } });
  }

  kill() {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch (e) {
        /* already gone */
      }
    }
  }
}

function describeTool(block) {
  const input = block.input || {};
  const target =
    input.file_path || input.path || input.pattern || input.command || input.description || input.query || input.url || '';
  return { name: block.name || 'Tool', target: String(target), filePath: input.file_path || null };
}

/* ---------- View: chat panel ---------- */

class ClaudeChatView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.sessionId = null;
    this.session = null;
    this.busy = false;
    this.turn = null;
    this.conv = null; // conversation being recorded in the history
    this.needsRestart = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return 'Claude';
  }
  getIcon() {
    return ICON_ID;
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('claude-chat');

    const header = root.createDiv({ cls: 'claude-chat-header' });
    header.createSpan({ cls: 'claude-chat-title', text: 'Claude' });
    this.modeEl = header.createSpan({ cls: 'claude-chat-mode' });
    const historyBtn = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'History' } });
    obsidian.setIcon(historyBtn, 'history');
    historyBtn.addEventListener('click', () => this.toggleHistory());
    const newBtn = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'New conversation' } });
    obsidian.setIcon(newBtn, 'plus');
    newBtn.addEventListener('click', () => this.newConversation());
    const closeBtn = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Close panel' } });
    obsidian.setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => this.leaf.detach());

    this.historyEl = root.createDiv({ cls: 'claude-chat-history' });
    this.historyEl.style.display = 'none';

    this.messagesEl = root.createDiv({ cls: 'claude-chat-messages' });
    this.messagesEl.addEventListener('click', (ev) => {
      const link = ev.target.closest ? ev.target.closest('a.internal-link') : null;
      if (!link) return;
      ev.preventDefault();
      const href = link.getAttribute('data-href') || link.getAttribute('href');
      if (href) this.app.workspace.openLinkText(href, '', ev.ctrlKey || ev.metaKey);
    });

    const composer = (this.composerEl = root.createDiv({ cls: 'claude-chat-composer' }));
    this.contextEl = composer.createDiv({ cls: 'claude-chat-context' });
    this.inputEl = composer.createEl('textarea', {
      cls: 'claude-chat-input',
      attr: { placeholder: 'Ask Claude to work on your notes…', rows: '3' },
    });
    const actions = composer.createDiv({ cls: 'claude-chat-actions' });
    this.modelEl = actions.createEl('select', { cls: 'dropdown claude-chat-model', attr: { 'aria-label': 'Model' } });
    this.modelEl.addEventListener('change', async () => {
      this.plugin.settings.model = this.modelEl.value;
      await this.plugin.saveSettings();
    });
    actions.createDiv({ cls: 'claude-chat-spacer' });
    this.stopBtn = actions.createEl('button', { text: 'Stop' });
    this.stopBtn.addEventListener('click', () => this.stop(true));
    this.sendBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Send' });
    this.sendBtn.addEventListener('click', () => this.send());
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.send();
      }
    });

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshContext()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.refreshContext()));
    this.refreshModels();
    this.refreshContext();
    this.setBusy(false);
    this.showWelcome();
  }

  async onClose() {
    this.stop(false);
  }

  showWelcome() {
    this.messagesEl.empty();
    const w = this.messagesEl.createDiv({ cls: 'claude-chat-welcome' });
    w.createEl('p', { text: 'Claude works directly on the files of this vault and follows CLAUDE.md, if present.' });
    w.createEl('p', { text: 'Enter to send, Shift+Enter for a new line.' });
  }

  newConversation() {
    this.stop(false);
    this.sessionId = null;
    this.conv = null;
    this.hideHistory();
    this.showWelcome();
    this.inputEl.focus();
  }

  /** Settings or model changed: the session restarts (and resumes) on the next message. */
  onSettingsChanged() {
    if (this.busy) this.needsRestart = true;
    else if (this.session) {
      this.session.kill();
      this.session = null;
    }
    this.refreshModels();
    this.refreshContext();
  }

  refreshModels() {
    if (!this.modelEl) return;
    const current = this.plugin.settings.model || '';
    this.modelEl.empty();
    const presets = MODEL_PRESETS.slice();
    if (!presets.some((p) => p[0] === current)) presets.push([current, current]);
    presets.forEach(([value, label]) => this.modelEl.createEl('option', { value, text: label }));
    this.modelEl.value = current;
  }

  /** Active note in the editor and its selected text. */
  getContext() {
    if (!this.plugin.settings.includeActiveNote) return null;
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    let selection = '';
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      if (v && v.file && v.file.path === file.path && v.editor) {
        selection = v.editor.getSelection() || '';
        break;
      }
    }
    return { path: file.path, selection };
  }

  refreshContext() {
    if (!this.contextEl) return;
    this.contextEl.empty();
    this.modeEl.setText(PERMISSION_LABELS[this.plugin.settings.permissionMode] || '');
    const ctx = this.getContext();
    if (!ctx) return;
    const chip = this.contextEl.createSpan({ cls: 'claude-chat-chip' });
    obsidian.setIcon(chip.createSpan({ cls: 'claude-chat-chip-icon' }), 'file-text');
    chip.createSpan({ text: path.basename(ctx.path, '.md') });
    chip.setAttr('aria-label', 'Open note: Claude receives it as context');
  }

  setBusy(busy) {
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.stopBtn.style.display = busy ? '' : 'none';
    this.sendBtn.setText(busy ? 'Working…' : 'Send');
  }

  /** Stops the work in progress. The conversation stays: the next message resumes it. */
  stop(announce) {
    const wasBusy = this.busy;
    if (this.session) {
      this.session.kill();
      this.session = null;
    }
    this.messagesEl.querySelectorAll('.claude-chat-permission:not(.is-answered)').forEach((el) => {
      el.addClass('is-answered');
      el.querySelectorAll('button').forEach((b) => (b.disabled = true));
    });
    if (wasBusy) {
      this.endTurn();
      if (announce) this.addNote('Stopped.');
    }
  }

  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /* --- History --- */

  record(item) {
    if (this.conv) this.conv.items.push(item);
  }

  async persist() {
    const conv = this.conv;
    if (!conv) return;
    conv.sessionId = this.sessionId;
    conv.updated = Date.now();
    const list = this.plugin.settings.conversations.filter((c) => c.id !== conv.id);
    list.unshift(conv);
    this.plugin.settings.conversations = list.slice(0, MAX_CONVERSATIONS);
    await this.plugin.saveData(this.plugin.settings);
  }

  toggleHistory() {
    if (this.historyEl.style.display === 'none') this.showHistory();
    else this.hideHistory();
  }

  hideHistory() {
    this.historyEl.style.display = 'none';
    this.messagesEl.style.display = '';
    this.composerEl.style.display = '';
  }

  showHistory() {
    const el = this.historyEl;
    el.empty();
    el.style.display = '';
    this.messagesEl.style.display = 'none';
    this.composerEl.style.display = 'none';

    const top = el.createDiv({ cls: 'claude-chat-history-top' });
    top.createSpan({ cls: 'claude-chat-history-heading', text: 'History' });
    const back = top.createEl('button', { text: 'Back to chat' });
    back.addEventListener('click', () => this.hideHistory());

    const list = this.plugin.settings.conversations;
    if (!list.length) {
      el.createDiv({ cls: 'claude-chat-welcome', text: 'No saved conversations yet.' });
      return;
    }
    list.forEach((conv) => {
      const row = el.createDiv({ cls: 'claude-chat-history-row' });
      if (this.conv && this.conv.id === conv.id) row.addClass('is-current');
      const main = row.createDiv({ cls: 'claude-chat-history-main' });
      main.createDiv({ cls: 'claude-chat-history-title', text: conv.title || 'Untitled' });
      main.createDiv({ cls: 'claude-chat-history-date', text: new Date(conv.updated).toLocaleString() });
      main.addEventListener('click', () => this.loadConversation(conv));
      const del = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Delete from history' } });
      obsidian.setIcon(del, 'trash-2');
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        this.plugin.settings.conversations = this.plugin.settings.conversations.filter((c) => c.id !== conv.id);
        await this.plugin.saveData(this.plugin.settings);
        if (this.conv && this.conv.id === conv.id) this.conv = null;
        this.showHistory();
      });
    });
  }

  loadConversation(conv) {
    this.stop(false);
    this.conv = conv;
    this.sessionId = conv.sessionId || null;
    this.messagesEl.empty();
    for (const item of conv.items) {
      if (item.t === 'user') this.renderUser(item.text, item.ctx);
      else if (item.t === 'assistant') {
        const b = this.messagesEl.createDiv({ cls: 'claude-chat-msg is-assistant markdown-rendered' });
        this.renderInto(b, item.text);
      } else if (item.t === 'tool') this.renderTool(item);
      else if (item.t === 'note') this.addNote(item.text, item.cls);
    }
    this.hideHistory();
    this.scrollToBottom();
    this.inputEl.focus();
  }

  /* --- Message rendering --- */

  addNote(text, cls, keep) {
    const el = this.messagesEl.createDiv({ cls: 'claude-chat-note ' + (cls || '') });
    el.setText(text);
    if (keep) this.record({ t: 'note', text, cls: cls || '' });
    this.scrollToBottom();
    return el;
  }

  renderUser(text, ctxLabel) {
    const el = this.messagesEl.createDiv({ cls: 'claude-chat-msg is-user' });
    el.setText(text);
    if (ctxLabel) el.createDiv({ cls: 'claude-chat-msg-context', text: ctxLabel });
  }

  toVaultRelative(filePath) {
    if (!filePath) return null;
    const r = path.relative(this.plugin.getVaultPath(), filePath);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
    return r.split(path.sep).join('/');
  }

  /** item: { name, target, rel } */
  renderTool(item) {
    const el = this.messagesEl.createDiv({ cls: 'claude-chat-tool' });
    obsidian.setIcon(el.createSpan({ cls: 'claude-chat-tool-icon' }), 'wrench');
    el.createSpan({ cls: 'claude-chat-tool-name', text: item.name });
    if (item.rel) {
      const a = el.createEl('a', { cls: 'internal-link claude-chat-tool-target', text: item.rel });
      a.setAttr('data-href', item.rel);
    } else if (item.target) {
      el.createSpan({ cls: 'claude-chat-tool-target', text: item.target });
    }
    this.scrollToBottom();
  }

  addTool(block) {
    const info = describeTool(block);
    const item = {
      t: 'tool',
      name: info.name,
      target: info.target.length > 90 ? info.target.slice(0, 90) + '…' : info.target,
      rel: this.toVaultRelative(info.filePath),
    };
    this.record(item);
    this.renderTool(item);
  }

  /** "Claude asks for permission" card: Allow / Always allow / Deny. */
  addPermission(request) {
    this.clearThinking();
    const session = this.session;
    const card = this.messagesEl.createDiv({ cls: 'claude-chat-permission' });
    card.createDiv({ cls: 'claude-chat-permission-title', text: 'Claude asks for permission: ' + request.toolName });
    const info = describeTool({ name: request.toolName, input: request.input });
    const rel = this.toVaultRelative(info.filePath);
    if (rel || info.target) card.createEl('pre', { cls: 'claude-chat-permission-detail', text: rel || info.target });
    const row = card.createDiv({ cls: 'claude-chat-permission-actions' });
    const answer = (decision, label) => {
      if (card.hasClass('is-answered')) return;
      card.addClass('is-answered');
      row.empty();
      row.createSpan({ cls: 'claude-chat-permission-answer', text: label });
      if (session && session.alive) session.respondPermission(request, decision);
    };
    const allow = row.createEl('button', { cls: 'mod-cta', text: 'Allow' });
    allow.addEventListener('click', () => answer('allow', 'Allowed'));
    if (request.suggestions.length) {
      const always = row.createEl('button', { text: 'Always allow' });
      always.setAttr('aria-label', 'Stop asking for this kind of action in this conversation');
      always.addEventListener('click', () => answer('always', 'Allowed for this conversation'));
    }
    const deny = row.createEl('button', { text: 'Deny' });
    deny.addEventListener('click', () => answer('deny', 'Denied'));
    this.scrollToBottom();
  }

  /* --- Streaming answer bubble --- */

  clearThinking() {
    if (this.turn && this.turn.thinking) {
      this.turn.thinking.remove();
      this.turn.thinking = null;
    }
  }

  renderInto(target, text) {
    const tmp = createDiv();
    return obsidian.MarkdownRenderer.render(this.app, text, tmp, '', this).then(() => {
      target.empty();
      while (tmp.firstChild) target.appendChild(tmp.firstChild);
      this.scrollToBottom();
    });
  }

  appendText(delta) {
    const t = this.turn;
    if (!t) return;
    if (!t.bubble) {
      t.bubble = this.messagesEl.createDiv({ cls: 'claude-chat-msg is-assistant markdown-rendered' });
      t.text = '';
    }
    t.text += delta;
    if (!t.timer) {
      t.timer = window.setTimeout(() => {
        t.timer = null;
        if (t.bubble) this.renderInto(t.bubble, t.text);
      }, 120);
    }
  }

  /** Closes the current bubble: after a tool use, text continues in a new one. */
  closeBubble() {
    const t = this.turn;
    if (!t) return;
    if (t.timer) {
      window.clearTimeout(t.timer);
      t.timer = null;
    }
    if (t.bubble) {
      this.renderInto(t.bubble, t.text);
      if (t.text.trim()) this.record({ t: 'assistant', text: t.text });
    }
    t.bubble = null;
    t.text = '';
  }

  endTurn() {
    this.clearThinking();
    this.closeBubble();
    this.turn = null;
    this.setBusy(false);
    if (this.needsRestart) {
      this.needsRestart = false;
      if (this.session) {
        this.session.kill();
        this.session = null;
      }
    }
    this.persist();
  }

  ensureSession() {
    if (this.session && this.session.alive) return true;
    const claudePath = findClaude(this.plugin.settings.claudePath);
    if (!claudePath) {
      this.addNote(
        'Claude Code was not found on this computer. Set the path to the claude executable in Settings → Claude Chat.',
        'is-error'
      );
      return false;
    }
    const view = this;
    const resuming = !!this.sessionId;
    const session = new ClaudeSession(
      {
        claudePath,
        cwd: this.plugin.getVaultPath(),
        sessionId: this.sessionId,
        permissionMode: this.plugin.settings.permissionMode,
        model: (this.plugin.settings.model || '').trim(),
      },
      {
        onInit: (sid) => {
          if (sid) view.sessionId = sid;
        },
        onText: (delta) => {
          view.clearThinking();
          view.appendText(delta);
        },
        onAssistant: (blocks, streamed) => {
          view.clearThinking();
          for (const b of blocks) {
            if (b.type === 'text' && !streamed && b.text) view.appendText(b.text);
          }
          const tools = blocks.filter((b) => b.type === 'tool_use');
          if (tools.length) {
            view.closeBubble();
            tools.forEach((b) => view.addTool(b));
          }
        },
        onPermission: (request) => view.addPermission(request),
        onResult: (msg) => {
          const failed = msg.is_error || (msg.subtype && msg.subtype !== 'success');
          if (failed && resuming && !session.initialized) {
            // The saved Claude Code session is gone: keep the transcript, start fresh next time.
            view.sessionId = null;
            session.kill();
            if (view.session === session) view.session = null;
            view.addNote('This conversation could not be resumed. Send your message again to continue in a fresh session.', 'is-error');
            view.endTurn();
            return;
          }
          if (msg.session_id) view.sessionId = msg.session_id;
          if (failed) {
            const detail = typeof msg.result === 'string' && msg.result ? msg.result : msg.subtype || 'error';
            view.addNote('The turn ended with an error: ' + detail, 'is-error', true);
          }
          view.endTurn();
          view.inputEl.focus();
        },
        onError: (text) => view.addNote(text, 'is-error'),
        onClose: (code) => {
          if (view.session === session) view.session = null;
          if (!view.busy) return;
          if (code && resuming && !session.initialized) {
            // The saved Claude Code session is gone: keep the transcript, start fresh next time.
            view.sessionId = null;
            view.addNote('This conversation could not be resumed. Send your message again to continue in a fresh session.', 'is-error');
          } else {
            view.addNote('Claude Code exited' + (code ? ' (code ' + code + ').' : '.'), 'is-error');
          }
          view.endTurn();
        },
      }
    );
    session.start();
    this.session = session;
    return true;
  }

  send() {
    if (this.busy) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.ensureSession()) return;

    if (this.messagesEl.querySelector('.claude-chat-welcome')) this.messagesEl.empty();
    this.inputEl.value = '';

    const ctx = this.getContext();
    let prompt = text;
    let ctxLabel = '';
    if (ctx) {
      let pre = '[Context from Obsidian] Open note: ' + ctx.path;
      if (ctx.selection.trim()) pre += '\nSelected text:\n"""\n' + ctx.selection + '\n"""';
      prompt = pre + '\n\n' + text;
      ctxLabel = path.basename(ctx.path, '.md') + (ctx.selection.trim() ? ' (selection)' : '');
    }

    if (!this.conv) {
      this.conv = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        sessionId: null,
        title: text.replace(/\s+/g, ' ').slice(0, 70),
        updated: Date.now(),
        items: [],
      };
    }
    this.record({ t: 'user', text, ctx: ctxLabel });
    this.renderUser(text, ctxLabel);
    this.persist();

    this.turn = { bubble: null, text: '', timer: null, thinking: null };
    this.setBusy(true);
    this.turn.thinking = this.addNote('Claude is thinking…', 'is-thinking');
    this.session.sendUser(prompt);
  }
}

/* ---------- Settings ---------- */

class ClaudeChatSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const found = findClaude(this.plugin.settings.claudePath);

    new obsidian.Setting(containerEl)
      .setName('Access level')
      .setDesc('What Claude may do without asking. When a permission is needed, a card with Allow / Deny appears in the chat.')
      .addDropdown((d) => {
        Object.keys(PERMISSION_LABELS).forEach((k) => d.addOption(k, PERMISSION_LABELS[k]));
        d.setValue(this.plugin.settings.permissionMode).onChange(async (v) => {
          this.plugin.settings.permissionMode = v;
          await this.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Send the open note as context')
      .setDesc('Claude receives the path of the active note and any selected text.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeActiveNote).onChange(async (v) => {
          this.plugin.settings.includeActiveNote = v;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Model')
      .setDesc('You can also pick it from the chat panel. Leave empty for the Claude Code default, or type an alias (fable, opus, sonnet, haiku) or a full model ID.')
      .addText((t) =>
        t.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Claude Code path')
      .setDesc('Leave empty for automatic detection. Currently found: ' + (found || 'none'))
      .addText((t) =>
        t
          .setPlaceholder('C:\\...\\claude.exe')
          .setValue(this.plugin.settings.claudePath)
          .onChange(async (v) => {
            this.plugin.settings.claudePath = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('History')
      .setDesc(this.plugin.settings.conversations.length + ' saved conversations (the most recent ' + MAX_CONVERSATIONS + ' are kept).')
      .addButton((b) =>
        b
          .setButtonText('Clear history')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.conversations = [];
            await this.plugin.saveData(this.plugin.settings);
            this.display();
          })
      );
  }
}

/* ---------- Plugin ---------- */

class ClaudeChatPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.conversations)) this.settings.conversations = [];
    obsidian.addIcon(ICON_ID, ICON_SVG);
    this.registerView(VIEW_TYPE, (leaf) => new ClaudeChatView(leaf, this));
    this.addRibbonIcon(ICON_ID, 'Claude', () => this.activateView());
    this.addCommand({
      id: 'open-claude-chat',
      name: 'Open chat',
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'new-claude-conversation',
      name: 'New conversation',
      callback: async () => {
        const view = await this.activateView();
        if (view) view.newConversation();
      },
    });
    this.addSettingTab(new ClaudeChatSettingTab(this.app, this));
  }

  getVaultPath() {
    return this.app.vault.adapter.getBasePath();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view && leaf.view.onSettingsChanged) leaf.view.onSettingsChanged();
    });
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view && view.inputEl) view.inputEl.focus();
    return view;
  }
}

module.exports = ClaudeChatPlugin;
module.exports.default = ClaudeChatPlugin;
module.exports._engine = { findClaude, ClaudeSession, describeTool };
