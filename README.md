# dsh-annotation

<div align="center">

**English** · [简体中文](./README.zh-CN.md)

</div>

<p align="center">Selection-annotation plugin for DSH Web: select text → annotate → press Enter to send it along with your message; the model replies to each annotation by number.</p>

<p align="center">
  <img src="https://badgen.net/badge/license/MIT/blue" alt="license">
</p>
<img width="2940" height="1770" alt="image" src="https://github.com/user-attachments/assets/c3186efc-44d3-4e7f-9523-1902d9d037e9" />
<img width="2940" height="1770" alt="image" src="https://github.com/user-attachments/assets/0b48ac02-4648-4b94-8d8f-344f8b7c25b4" />
<img width="2940" height="1770" alt="image" src="https://github.com/user-attachments/assets/8b2610d0-3d00-41be-b314-bac2fe616787" />
<img width="2940" height="1770" alt="image" src="https://github.com/user-attachments/assets/9b66deea-3786-4296-9b0d-52873a15f5e1" />

Select any text in an assistant reply to annotate it (the annotation body may be left empty = just mark the passage). Annotations accumulate across messages and turns. An **Annotations ×N** chip appears next to the input box — hover to view all annotations, remove them one by one. Press Enter and the annotation block goes to the model together with whatever question is in the input box. **The annotation block never shows up as text in your own message bubble** — only the question plus the chip (content visible on hover; hidden before paint, zero flicker). The model replies with `Annotation 1: …` … `Annotation N: …`, one per annotation, and every Annotation label in the reply is a hoverable chip showing the annotated passage and your note.

Form: official **bundle plugin** (`dsh.bundle` + a `dsh.client` declaration in package.json, injected into the browser via client-modules; the Node half is an empty implementation). **Zero core changes** — no DSH files are touched; `cordis.patch.yml` only inserts its own id once, and the profile patch stays `[]`.

## Features

| Feature | Description |
|---|---|
| Select-to-annotate | Select assistant text → toolbar "Annotate" → write your note (may be empty); dismiss by clicking elsewhere or pressing Esc |
| Numbered marker + highlight | A blue numbered marker + highlight anchored to the passage, viewport-anchored with collision avoidance, never lost when scrolled out of view |
| Cross-turn collection | Any number of annotations accumulate across messages/turns, numbered from 1 |
| "Annotations ×N" chip | Small chip beside the input box; hover shows every annotation, deletable individually |
| Enter sends with your message | Annotation block + the question in the input box are sent to the model together (the model receives the full content) |
| Hidden in your bubble | The annotation block is removed from your bubble's DOM the moment you send (before the browser paints), leaving only the question + the chip (hover to view); historical messages self-heal after a refresh |
| Numbered reply correspondence | A format instruction is injected into the message so the model replies `Annotation 1: …` … `Annotation N: …` one by one |
| Reply annotation chips | `Annotation N:` in the reply renders as hoverable chips showing the passage + your note |

## Interaction flow

```
Select assistant text ──▶ Toolbar "Annotate" ──▶ Write note / save empty ──▶ Blue numbered marker + highlight
        ▲                                                        │
        └────────────── any number, accumulate across turns ◀────┘
                                │
                                ▼
              "Annotations ×N" chip beside the input (hover to view / delete)
                                │
                            Press Enter
                                ▼
    Model receives: annotation block (number + passage + note) + your question
    Your bubble: question only + "Annotations ×N" chip (zero flicker)
    Model reply: Annotation 1: … Annotation 2: … (hoverable chips)
```

## Install (official bundle path · the only one)

```sh
# Public GitHub install (works without an npm account)
dsh plugin --profile web add git+https://github.com/omdsh-dev/dsh-annotation.git
# local path install (development / debugging)
cd /path/to/dsh-annotation
dsh plugin --profile web add .
# restart the web service — see "Restarting the web service" below
```

| Do | Don't |
|----|------|
| Only `dsh plugin add` / only write `bundles` | **Never** insert the same id again in the profile/home `cordis.patch.yml` |

Self-check:

```sh
dsh --profile web --dump-config | rg "id: dsh-annotation"   # must be exactly 1 line
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3080/plugins/@omdsh-dev/dsh-annotation/client.js"   # 200
```

## Restarting the web service

Pick the command for your platform:

```sh
# macOS (launchd)
launchctl kickstart -k "gui/$(id -u)/com.dsh.web"

# WSL / Linux with systemd user services
# The unit name may differ by install method; check with:
#   systemctl --user list-units | rg dsh
systemctl --user restart dsh-web
```

Environments without a service manager (e.g. some containers) often need **no restart at all**: `client.js` is served per request with no caching, so a hard refresh (Cmd/Ctrl+Shift+R) picks up plugin changes. The self-check commands above are platform-neutral.

## Architecture notes

- **Pure browser-side**: everything lives in `client.js` (a hand-written CJS bundle, no build step, served no-cache per request)
- **Message format** (the literal protocol block sent to the model):

  ```
  我批注了以下 N 处内容…\n\n1. 原文\n   批注：…\n\n请用「Annotation 1：…」…\n\n提问：
  ```

  The delimiter is 「提问：」(ask:) rather than 「问题：」(question:) — the heading line "回答我的问题：" also contains the latter, and the bubble-hiding surgery would misfire on it.
- **Bubble hiding**: user bubbles are plain-text rendered (a single MessageText node, not markdown); a MutationObserver in the microtask phase (before paint) splits at the last `\n提问：`, cuts the annotation block, and attaches the chip; a 1 s polling fallback plus historical-message repair after refresh
- **Reply chips**: after streaming settles (`data-streaming` removed), each `Annotation N:` is replaced with a hoverable chip; item data is stored on the most recent user message carrying the annotation tag (`tag.__annotationItems`) and rebuilt after refresh; **snapshot the text nodes collected by the TreeWalker before touching the DOM, then replace one by one** — replacing a child mid-walk invalidates the walker pointer and only the first node gets processed
- **IME-safe**: the Enter interception carries `isComposing` / keyCode 229 guards; never hard-edits the composer textarea's DOM; `setDraft` only assembles the annotation block at the last moment before submit and never clobbers the user's draft
- **No reliance on send-completion event chains**: bubble decoration uses MutationObserver + polling (`watchInputDraft` can be ineffective before the session is loaded at init; it is only a staging entry)
- **Focus-chat compatible**: works inside the focus conversation view of [dsh-focus-chat](https://github.com/dingyi222666/dsh-focus-chat) — assistant rows there are `[data-focus-flow]` containers with a `*_assistant` CSS-Modules class (plus `data-streaming` while running); selection, annotation, reply chips, and re-anchoring all work in the focus tab alongside the main chat view

## Version history

| Version | Highlights |
|---|---|
| v1.3.x | Numbered reply correspondence: format-instruction injection + hoverable `Annotation N:` chips (TreeWalker snapshot fix) |
| v1.2.x | Hidden annotation block in bubble: MutationObserver microtask zero-flicker + polling fallback + historical-message repair |
| v1.x | Self-contained annotation flow (replaces the v0.9 chip design): capture-Enter assembles the block and sends it with the message |
| v0.9.x | Early chip design (insertReference + slash codec), superseded by v1.x |

## Friendly links

- [Linux.do](https://linux.do)

## License

MIT
