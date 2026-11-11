# Claude Chat per Obsidian

Un pannello laterale di Obsidian con una conversazione [Claude Code](https://claude.com/claude-code) che lavora direttamente sulle note del vault, in modo simile all'estensione di Claude Code per VS Code.

> Plugin non ufficiale: non è sviluppato né approvato da Anthropic o da Obsidian.
>
> *English summary: an unofficial Obsidian side panel that runs a Claude Code agent inside your vault. The interface is in Italian. Tested on Windows only.*

## Cosa fa

- **Tasto Claude** nella barra laterale sinistra: apre il pannello chat a destra.
- **Agente sul vault**: Claude Code parte nella cartella del vault, quindi legge e modifica le note e segue il file `CLAUDE.md`, se presente.
- **Contesto automatico**: la nota aperta e il testo selezionato vengono passati a Claude.
- **Permessi**: quando serve un'autorizzazione compare una scheda con Consenti / Consenti sempre / Nega.
- **Risposte in streaming**, rese come Markdown di Obsidian; i file toccati sono collegamenti cliccabili.

## Requisiti

- Obsidian desktop (il plugin non funziona su mobile).
- Claude Code installato e con l'accesso già fatto. Il plugin lo cerca da solo:
  - nell'app desktop di Claude per Windows,
  - nell'estensione Claude Code di VS Code,
  - nel `PATH` di sistema.

  Se non lo trova, indica il percorso dell'eseguibile nelle impostazioni del plugin.
- Collaudato solo su Windows. Su macOS e Linux dovrebbe funzionare se `claude` è nel `PATH`, ma non è stato provato.

## Installazione

### Con BRAT

1. Installa il plugin della community **BRAT**.
2. In BRAT scegli "Add beta plugin" e incolla `LuigiGiordanoOrsini/obsidian-claude-chat`.

### A mano

1. Scarica `main.js`, `manifest.json` e `styles.css` dall'ultima [release](https://github.com/LuigiGiordanoOrsini/obsidian-claude-chat/releases).
2. Copiali in `<vault>/.obsidian/plugins/claude-chat/`.
3. Riavvia Obsidian e abilita "Claude Chat" in Impostazioni → Plugin della community.

## Uso

- Invio manda il messaggio, Maiusc+Invio va a capo.
- "Stop" interrompe il lavoro in corso; il messaggio successivo riprende la stessa conversazione.
- "+" apre una nuova conversazione.

## Livello di accesso

In Impostazioni → Claude Chat scegli cosa può fare Claude senza chiedere:

| Livello | Comportamento |
|---|---|
| Modifica le note, chiede per i comandi (predefinito) | Legge e scrive i file; chiede prima di eseguire comandi di sistema. |
| Chiede prima di ogni modifica | Chiede anche prima di scrivere un file. |
| Sola lettura | Legge e pianifica, non modifica nulla. |
| Accesso completo, non chiede mai | Nessuna richiesta di permesso. Usalo solo se sai cosa comporta. |

## Limiti noti

- Nessuna anteprima delle differenze prima di una modifica.
- La cronologia delle conversazioni non viene salvata alla chiusura di Obsidian.
- Interfaccia solo in italiano.

## Privacy

Il plugin non invia dati per conto suo: avvia Claude Code sul tuo computer, che comunica con Anthropic usando il tuo account. Le note che Claude legge fanno parte di quella conversazione.

## Licenza

[MIT](LICENSE)
