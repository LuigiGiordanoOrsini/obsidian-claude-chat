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

const DEFAULT_SETTINGS = {
  claudePath: '',
  permissionMode: 'acceptEdits',
  model: '',
  includeActiveNote: true,
};

const PERMISSION_LABELS = {
  acceptEdits: 'Modifica le note, chiede per i comandi',
  default: 'Chiede prima di ogni modifica',
  plan: 'Sola lettura (pianifica, non modifica)',
  bypassPermissions: 'Accesso completo, non chiede mai',
};

/* ---------- Motore: trova ed esegue Claude Code ---------- */

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

/** Cerca claude.exe installato dall'app desktop di Claude o dall'estensione VS Code. */
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
      /* non esiste */
    }
  }
  return best;
}

/**
 * Sessione persistente con Claude Code (stesso protocollo dell'estensione VS Code:
 * messaggi JSON su stdin/stdout, richieste di permesso via control_request).
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
      h.onInit && h.onInit(msg.session_id);
    } else if (msg.type === 'stream_event') {
      if (msg.parent_tool_use_id) return; // output dei sotto-agenti: non mostrarlo
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
          response: { subtype: 'error', request_id: msg.request_id, error: 'Richiesta non supportata: ' + req.subtype },
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
      response = { behavior: 'deny', message: "L'utente ha negato questa azione." };
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
        /* gia' terminato */
      }
    }
  }
}

function describeTool(block) {
  const input = block.input || {};
  const target =
    input.file_path || input.path || input.pattern || input.command || input.description || input.query || input.url || '';
  return { name: block.name || 'Strumento', target: String(target), filePath: input.file_path || null };
}

/* ---------- Vista: pannello chat ---------- */

class ClaudeChatView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.sessionId = null;
    this.session = null;
    this.busy = false;
    this.turn = null;
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
    const newBtn = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Nuova conversazione' } });
    obsidian.setIcon(newBtn, 'plus');
    newBtn.addEventListener('click', () => this.newConversation());

    this.messagesEl = root.createDiv({ cls: 'claude-chat-messages' });
    this.messagesEl.addEventListener('click', (ev) => {
      const link = ev.target.closest ? ev.target.closest('a.internal-link') : null;
      if (!link) return;
      ev.preventDefault();
      const href = link.getAttribute('data-href') || link.getAttribute('href');
      if (href) this.app.workspace.openLinkText(href, '', ev.ctrlKey || ev.metaKey);
    });

    const composer = root.createDiv({ cls: 'claude-chat-composer' });
    this.contextEl = composer.createDiv({ cls: 'claude-chat-context' });
    this.inputEl = composer.createEl('textarea', {
      cls: 'claude-chat-input',
      attr: { placeholder: 'Chiedi a Claude di lavorare sulle tue note…', rows: '3' },
    });
    const actions = composer.createDiv({ cls: 'claude-chat-actions' });
    this.stopBtn = actions.createEl('button', { text: 'Stop' });
    this.stopBtn.addEventListener('click', () => this.stop(true));
    this.sendBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Invia' });
    this.sendBtn.addEventListener('click', () => this.send());
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.send();
      }
    });

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshContext()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.refreshContext()));
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
    w.createEl('p', { text: 'Claude lavora direttamente sui file di questo vault e segue le regole di CLAUDE.md.' });
    w.createEl('p', { text: 'Invio per mandare, Maiusc+Invio per andare a capo.' });
  }

  newConversation() {
    this.stop(false);
    this.sessionId = null;
    this.showWelcome();
    this.inputEl.focus();
  }

  /** Chiamato quando cambiano le impostazioni: la sessione riparte al prossimo messaggio. */
  onSettingsChanged() {
    if (!this.busy) this.stop(false);
    this.refreshContext();
  }

  /** Nota attiva nell'editor e testo selezionato. */
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
    chip.setAttr('aria-label', 'Nota aperta: Claude la riceve come contesto');
  }

  setBusy(busy) {
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.stopBtn.style.display = busy ? '' : 'none';
    this.sendBtn.setText(busy ? 'Sto lavorando…' : 'Invia');
  }

  /** Ferma il lavoro in corso. La conversazione resta: il prossimo messaggio la riprende. */
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
      if (announce) this.addNote('Interrotto.');
    }
  }

  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  addNote(text, cls) {
    const el = this.messagesEl.createDiv({ cls: 'claude-chat-note ' + (cls || '') });
    el.setText(text);
    this.scrollToBottom();
    return el;
  }

  toVaultRelative(filePath) {
    if (!filePath) return null;
    const r = path.relative(this.plugin.getVaultPath(), filePath);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
    return r.split(path.sep).join('/');
  }

  addTool(block) {
    const info = describeTool(block);
    const el = this.messagesEl.createDiv({ cls: 'claude-chat-tool' });
    obsidian.setIcon(el.createSpan({ cls: 'claude-chat-tool-icon' }), 'wrench');
    el.createSpan({ cls: 'claude-chat-tool-name', text: info.name });
    if (info.target) {
      const rel = this.toVaultRelative(info.filePath);
      if (rel) {
        const a = el.createEl('a', { cls: 'internal-link claude-chat-tool-target', text: rel });
        a.setAttr('data-href', rel);
      } else {
        const t = info.target.length > 90 ? info.target.slice(0, 90) + '…' : info.target;
        el.createSpan({ cls: 'claude-chat-tool-target', text: t });
      }
    }
    this.scrollToBottom();
  }

  /** Scheda "Claude chiede il permesso": Consenti / Consenti sempre / Nega. */
  addPermission(request) {
    this.clearThinking();
    const session = this.session;
    const card = this.messagesEl.createDiv({ cls: 'claude-chat-permission' });
    card.createDiv({ cls: 'claude-chat-permission-title', text: 'Claude chiede il permesso: ' + request.toolName });
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
    const allow = row.createEl('button', { cls: 'mod-cta', text: 'Consenti' });
    allow.addEventListener('click', () => answer('allow', 'Consentito'));
    if (request.suggestions.length) {
      const always = row.createEl('button', { text: 'Consenti sempre' });
      always.setAttr('aria-label', 'Non chiedere più per azioni di questo tipo in questa conversazione');
      always.addEventListener('click', () => answer('always', 'Consentito per questa conversazione'));
    }
    const deny = row.createEl('button', { text: 'Nega' });
    deny.addEventListener('click', () => answer('deny', 'Negato'));
    this.scrollToBottom();
  }

  /* --- Bolla di risposta in streaming --- */

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

  /** Chiude la bolla corrente: dopo un uso di strumento il testo riparte in una bolla nuova. */
  closeBubble() {
    const t = this.turn;
    if (!t) return;
    if (t.timer) {
      window.clearTimeout(t.timer);
      t.timer = null;
    }
    if (t.bubble) this.renderInto(t.bubble, t.text);
    t.bubble = null;
    t.text = '';
  }

  endTurn() {
    this.clearThinking();
    this.closeBubble();
    this.turn = null;
    this.setBusy(false);
  }

  ensureSession() {
    if (this.session && this.session.alive) return true;
    const claudePath = findClaude(this.plugin.settings.claudePath);
    if (!claudePath) {
      this.addNote(
        'Non trovo Claude Code su questo computer. Indica il percorso di claude.exe in Impostazioni → Claude Chat.',
        'is-error'
      );
      return false;
    }
    const view = this;
    const session = new ClaudeSession(
      {
        claudePath,
        cwd: this.plugin.getVaultPath(),
        sessionId: this.sessionId,
        permissionMode: this.plugin.settings.permissionMode,
        model: this.plugin.settings.model.trim(),
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
          if (msg.session_id) view.sessionId = msg.session_id;
          if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
            const detail = typeof msg.result === 'string' && msg.result ? msg.result : msg.subtype || 'errore';
            view.addNote('Il turno si è chiuso con un errore: ' + detail, 'is-error');
          }
          view.endTurn();
          view.inputEl.focus();
        },
        onError: (text) => view.addNote(text, 'is-error'),
        onClose: (code) => {
          if (view.session === session) view.session = null;
          if (view.busy) {
            view.addNote('Claude Code si è chiuso' + (code ? ' (codice ' + code + ').' : '.'), 'is-error');
            view.endTurn();
          }
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

    const userEl = this.messagesEl.createDiv({ cls: 'claude-chat-msg is-user' });
    userEl.setText(text);

    const ctx = this.getContext();
    let prompt = text;
    if (ctx) {
      let pre = '[Contesto da Obsidian] Nota aperta: ' + ctx.path;
      if (ctx.selection.trim()) pre += '\nTesto selezionato:\n"""\n' + ctx.selection + '\n"""';
      prompt = pre + '\n\n' + text;
      userEl.createDiv({
        cls: 'claude-chat-msg-context',
        text: path.basename(ctx.path, '.md') + (ctx.selection.trim() ? ' (selezione)' : ''),
      });
    }

    this.turn = { bubble: null, text: '', timer: null, thinking: null };
    this.setBusy(true);
    this.turn.thinking = this.addNote('Claude sta pensando…', 'is-thinking');
    this.session.sendUser(prompt);
  }
}

/* ---------- Impostazioni ---------- */

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
      .setName('Livello di accesso')
      .setDesc('Cosa può fare Claude senza chiedere. Quando serve un permesso, nella chat compare una scheda con Consenti / Nega.')
      .addDropdown((d) => {
        Object.keys(PERMISSION_LABELS).forEach((k) => d.addOption(k, PERMISSION_LABELS[k]));
        d.setValue(this.plugin.settings.permissionMode).onChange(async (v) => {
          this.plugin.settings.permissionMode = v;
          await this.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Passa la nota aperta come contesto')
      .setDesc('Claude riceve il percorso della nota attiva e l\'eventuale testo selezionato.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.includeActiveNote).onChange(async (v) => {
          this.plugin.settings.includeActiveNote = v;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Modello')
      .setDesc('Lascia vuoto per usare quello predefinito di Claude Code. Esempi: sonnet, opus, haiku.')
      .addText((t) =>
        t.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Percorso di Claude Code')
      .setDesc('Lascia vuoto per la ricerca automatica. Trovato ora: ' + (found || 'nessuno'))
      .addText((t) =>
        t
          .setPlaceholder('C:\\...\\claude.exe')
          .setValue(this.plugin.settings.claudePath)
          .onChange(async (v) => {
            this.plugin.settings.claudePath = v.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}

/* ---------- Plugin ---------- */

class ClaudeChatPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    obsidian.addIcon(ICON_ID, ICON_SVG);
    this.registerView(VIEW_TYPE, (leaf) => new ClaudeChatView(leaf, this));
    this.addRibbonIcon(ICON_ID, 'Claude', () => this.activateView());
    this.addCommand({
      id: 'open-claude-chat',
      name: 'Apri la chat con Claude',
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'new-claude-conversation',
      name: 'Nuova conversazione con Claude',
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
