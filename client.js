window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-annotation",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/codec.ts
		/** The source name (serializer routing key for annotation occurrences). */
		const SOURCE = "annotation";
		/** The model-facing label prefix inside chip rendering. */
		function chipLabel(index) {
			return `批注 ${index + 1}`;
		}
		/** One notice's readable markdown body: quote, source index, and the note. */
		function noticeText(item, index) {
			return [
				`> 引用：${item.target.exact}`,
				`来源：消息 ${item.target.messageId}，第 ${index} 处`,
				`批注：${item.note === "" ? "（未填写）" : item.note}`
			].join("\n");
		}
		function createAnnotationSource(registry) {
			return {
				trigger: "@",
				name: SOURCE,
				candidates: () => Promise.resolve([]),
				onPick: () => void 0,
				codec: {
					clipboardText: () => "",
					serialize(session, ref) {
						const draft = registry.get(session.sessionId);
						const index = draft.items.findIndex((item) => item.id === ref);
						if (index < 0) return Promise.reject(/* @__PURE__ */ new Error(`annotation "${ref}" is no longer pending in this session`));
						const item = draft.items[index];
						return Promise.resolve({
							kind: "context",
							batchId: draft.batchId,
							summary: `批注 ${index + 1}`,
							text: noticeText(item, index + 1)
						});
					},
					committed(session, ref) {
						registry.commit(session.sessionId, [ref]);
					}
				}
			};
		}
		/** A chip insertion for one pending item (inserted at the draft tail). */
		function chipInsert(item, index, draftLength, draftRev) {
			return {
				reference: {
					source: SOURCE,
					ref: item.id,
					label: chipLabel(index),
					clipboardText: ""
				},
				span: {
					start: draftLength,
					end: draftLength,
					draftRev
				}
			};
		}
		//#endregion
		//#region src/client/hash.ts
		/**
		* Deterministic, dependency-free content hash for batch ids. Not a security
		* primitive — it only needs to flip on ANY content change so a reused
		* batchId can never collide with changed data.
		*/
		/** FNV-1a 64-bit over UTF-16 code units, hex-encoded. */
		function contentHash(input) {
			let hash = 14695981039346656037n;
			const prime = 1099511628211n;
			for (let i = 0; i < input.length; i += 1) {
				hash ^= BigInt(input.charCodeAt(i));
				hash = hash * prime & 18446744073709551615n;
			}
			return hash.toString(16).padStart(16, "0");
		}
		//#endregion
		//#region src/client/store.ts
		/**
		* Per-session pending annotation state: the single source of truth for the
		* unsent batch. Persisted to localStorage per session (refresh, session
		* switch, and reopen all restore the exact draft); batch ids derive from the
		* item content so identical retries keep the id while any edit mints a new
		* one.
		*/
		const STORAGE_PREFIX = "dsh-annotation:draft:v1:";
		function storageKey(sessionId) {
			return STORAGE_PREFIX + sessionId;
		}
		/** Derive the batch id from the exact item payloads (id-excluded: ids are stable, content is not). */
		function deriveBatchId(items) {
			return `ann-${contentHash(items.map((item) => `${item.target.messageId}\u0000${item.target.start}\u0000${item.target.end}\u0000${item.target.exact}\u0000${item.note}`).join(""))}`;
		}
		/** Fresh empty per-session draft state. */
		function emptyDraft() {
			return {
				version: 1,
				batchId: deriveBatchId([]),
				items: []
			};
		}
		/** Load the persisted draft for one session; a missing or malformed record yields empty. */
		function loadDraft(sessionId, storage) {
			const raw = storage.getItem(storageKey(sessionId));
			if (raw === null) return emptyDraft();
			try {
				const parsed = JSON.parse(raw);
				if (!isDraftState(parsed)) return emptyDraft();
				return {
					version: 1,
					batchId: deriveBatchId(parsed.items),
					items: parsed.items
				};
			} catch {
				return emptyDraft();
			}
		}
		/** Persist one session's draft (best-effort; storage failures never throw). */
		function saveDraft(sessionId, draft, storage) {
			try {
				if (draft.items.length === 0) storage.removeItem(storageKey(sessionId));
				else storage.setItem(storageKey(sessionId), JSON.stringify(draft));
			} catch {}
		}
		/** Add one item (bound-checked). Returns null when the draft is full. */
		function addItem(draft, item) {
			if (draft.items.length >= 32) return null;
			if (!withinBounds(item)) return null;
			const items = [...draft.items, item];
			return {
				draft: {
					version: 1,
					batchId: deriveBatchId(items),
					items
				},
				batchChanged: true
			};
		}
		/** Replace one item's note in place. Returns the previous state untouched when the id is unknown. */
		function updateNote(draft, id, note) {
			const items = draft.items.map((item) => item.id === id ? {
				...item,
				note
			} : item);
			if (items.every((item, index) => item === draft.items[index])) return {
				draft,
				batchChanged: false
			};
			return {
				draft: {
					version: 1,
					batchId: deriveBatchId(items),
					items
				},
				batchChanged: true
			};
		}
		/** Remove the items with the given ids in one step (the send-committed path). */
		function removeItems(draft, ids) {
			const drop = new Set(ids);
			const items = draft.items.filter((item) => !drop.has(item.id));
			if (items.length === draft.items.length) return {
				draft,
				batchChanged: false
			};
			return {
				draft: {
					version: 1,
					batchId: deriveBatchId(items),
					items
				},
				batchChanged: true
			};
		}
		/** Clear every pending item. */
		function clearItems(draft) {
			if (draft.items.length === 0) return {
				draft,
				batchChanged: false
			};
			const items = [];
			return {
				draft: {
					version: 1,
					batchId: deriveBatchId(items),
					items
				},
				batchChanged: true
			};
		}
		/** Local bound check for one item (quote 8 KiB, note 4 KiB). */
		function withinBounds(item) {
			return utf8Bytes(item.target.exact) <= 8192 && utf8Bytes(item.note) <= 4096;
		}
		/** Trim the anchor context strings to their documented length. */
		function boundAnchorContext(prefix, suffix) {
			return {
				prefix: prefix.slice(-40),
				suffix: suffix.slice(0, 40)
			};
		}
		/** UTF-8 byte length without TextEncoder allocations (browsers + jsdom). */
		function utf8Bytes(value) {
			let bytes = 0;
			for (let i = 0; i < value.length; i += 1) {
				const code = value.charCodeAt(i);
				if (code < 128) bytes += 1;
				else if (code < 2048) bytes += 2;
				else if (code >= 55296 && code <= 56319 && i + 1 < value.length) {
					const next = value.charCodeAt(i + 1);
					if (next >= 56320 && next <= 57343) {
						bytes += 4;
						i += 1;
					} else bytes += 3;
				} else bytes += 3;
			}
			return bytes;
		}
		function isDraftState(value) {
			if (typeof value !== "object" || value === null) return false;
			const candidate = value;
			if (candidate.version !== 1 || !Array.isArray(candidate.items)) return false;
			return candidate.items.every((item) => typeof item === "object" && item !== null && typeof item.id === "string" && typeof item.note === "string" && typeof item.target === "object");
		}
		//#endregion
		//#region src/client/anchor.ts
		/** Anchor re-location over the flattened plain text of ONE message. */
		function locateOffsets(plainText, target) {
			if (target.end <= plainText.length && plainText.slice(target.start, target.end) === target.exact) return {
				start: target.start,
				end: target.end
			};
			const candidates = [];
			let from = 0;
			while (true) {
				const at = plainText.indexOf(target.exact, from);
				if (at < 0) break;
				const before = plainText.slice(Math.max(0, at - target.prefix.length), at);
				const after = plainText.slice(at + target.exact.length, at + target.exact.length + target.suffix.length);
				let score = 0;
				if (target.prefix !== "") score += before === target.prefix ? 2 : 0;
				if (target.suffix !== "") score += after === target.suffix ? 2 : 0;
				candidates.push({
					start: at,
					end: at + target.exact.length,
					score
				});
				from = at + 1;
			}
			if (candidates.length === 0) return null;
			const best = candidates.reduce((current, candidate) => candidate.score > current.score ? candidate : current);
			if (candidates.length === 1 || best.score > 0) return {
				start: best.start,
				end: best.end
			};
			return null;
		}
		/** Build an anchor target from a DOM selection confined to ONE assistant message. */
		function extractTarget(selection, root) {
			if (selection.rangeCount === 0) return null;
			const range = selection.getRangeAt(0);
			if (range.collapsed) return null;
			const container = messageContainerOf(range.startContainer, root);
			if (container === null) return null;
			if (messageContainerOf(range.endContainer, root) !== container) return null;
			const messageId = container.getAttribute("data-dsh-assistant-message-id");
			if (messageId === null || messageId === "") return null;
			const text = flattenedText(container);
			if (text.nodes.length === 0) return null;
			const start = textOffsetOf(text, range.startContainer, range.startOffset);
			const end = textOffsetOf(text, range.endContainer, range.endOffset);
			if (start < 0 || end < start) return null;
			const exact = plainTextSlice(text, start, end);
			if (exact === "") return null;
			const { prefix, suffix } = boundAnchorContext(plainTextSlice(text, Math.max(0, start - 40), start), plainTextSlice(text, end, end + 40));
			return {
				messageId,
				start,
				end,
				exact,
				prefix,
				suffix
			};
		}
		/** The annotatable assistant message element containing `node`, if any. */
		function messageContainerOf(node, root) {
			let current = node;
			while (current !== null && current !== root) {
				if (current instanceof HTMLElement && current.hasAttribute("data-dsh-assistant-selectable")) return current;
				current = current.parentNode;
			}
			return null;
		}
		/** The annotatable message element with the given durable id, if present. */
		function messageElementOf(messageId, root) {
			return root.querySelector(`[data-dsh-assistant-selectable][data-dsh-assistant-message-id="${cssEscape(messageId)}"]`);
		}
		function flattenedText(container) {
			const nodes = [];
			const offsets = [];
			let total = 0;
			const walker = (container.ownerDocument ?? container.ownerDocument).createTreeWalker(container, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode();
			while (node !== null) {
				if (node instanceof Text && node.data.length > 0) {
					nodes.push(node);
					offsets.push(total);
					total += node.data.length;
				}
				node = walker.nextNode();
			}
			return {
				nodes,
				offsets,
				total
			};
		}
		/** Character offset of (node, offset) within one flattened message; -1 when foreign. */
		function textOffsetOf(text, node, offset) {
			const index = text.nodes.indexOf(node);
			if (index < 0) return -1;
			return (text.offsets[index] ?? 0) + offset;
		}
		/** Plain-text slice of one flattened message. */
		function plainTextSlice(text, start, end) {
			let out = "";
			for (let i = 0; i < text.nodes.length; i += 1) {
				const node = text.nodes[i];
				const nodeStart = text.offsets[i];
				const nodeEnd = nodeStart + node.data.length;
				if (nodeEnd <= start) continue;
				if (nodeStart >= end) break;
				const from = Math.max(start, nodeStart) - nodeStart;
				const to = Math.min(end, nodeEnd) - nodeStart;
				out += node.data.slice(from, to);
			}
			return out;
		}
		/** Resolve a target into a DOM Range inside its message element, or null when moved. */
		function resolveInDom(target, root) {
			const container = messageElementOf(target.messageId, root);
			if (container === null) return null;
			const text = flattenedText(container);
			const offsets = locateOffsets(plainTextSlice(text, 0, text.total), target);
			if (offsets === null) return null;
			const start = nodeAtOffset(text, offsets.start);
			const end = nodeAtOffset(text, offsets.end);
			if (start === null || end === null) return null;
			const range = root.createRange();
			range.setStart(start.node, start.offset);
			range.setEnd(end.node, end.offset);
			return range;
		}
		/** The (node, offset) pair owning one flattened offset. */
		function nodeAtOffset(text, offset) {
			for (let i = 0; i < text.nodes.length; i += 1) {
				const node = text.nodes[i];
				const nodeStart = text.offsets[i];
				if (offset <= nodeStart + node.data.length) return {
					node,
					offset: offset - nodeStart
				};
			}
			return null;
		}
		/** Minimal CSS identifier escaping for attribute selectors (message ids are seqs, defensive). */
		function cssEscape(value) {
			return value.replace(/["\\]/g, "\\$&");
		}
		//#endregion
		//#region src/client/highlight.ts
		/**
		* CSS Custom Highlight painting + floating pin badges for pending
		* annotations. Repositioning is merged through requestAnimationFrame (no
		* polling, no body observer); the pins live in ONE fixed overlay container
		* rendered by the panel component.
		*/
		const HIGHLIGHT_STYLE = "dsh-annotation-2";
		function highlightName(id) {
			return `${HIGHLIGHT_STYLE}:${id}`;
		}
		function createHighlightSurface(overlay, cssHighlights) {
			const paint = (items, root) => {
				const located = [];
				const seen = /* @__PURE__ */ new Set();
				const existing = /* @__PURE__ */ new Map();
				for (const child of Array.from(overlay.children)) {
					const id = child.getAttribute("data-ann2-item");
					if (id !== null) existing.set(id, child);
				}
				items.forEach((item, index) => {
					seen.add(item.id);
					const range = resolveInDom(item.target, root);
					const pin = existing.get(item.id);
					if (range === null) {
						pin?.remove();
						cssHighlights?.delete(highlightName(item.id));
						return;
					}
					located.push(item);
					cssHighlights?.set(highlightName(item.id), new Highlight(range));
					const rect = range.getBoundingClientRect();
					if (pin === void 0) {
						const created = root.createElement("div");
						created.className = "dsh-ann2-pin";
						created.dataset.ann2Item = item.id;
						created.textContent = String(index + 1);
						overlay.appendChild(created);
						return;
					}
					pin.style.left = `${rect.left + rect.width / 2}px`;
					pin.style.top = `${rect.top}px`;
					pin.style.display = rect.width === 0 ? "none" : "block";
				});
				for (const [id, pin] of existing) if (!seen.has(id)) {
					pin.remove();
					cssHighlights?.delete(highlightName(id));
				}
				return located;
			};
			const clear = () => {
				if (cssHighlights !== void 0) {
					for (const name of Array.from(cssHighlights.keys())) if (name.startsWith(`dsh-annotation-2:`)) cssHighlights.delete(name);
				}
				overlay.replaceChildren();
			};
			return {
				paint,
				clear
			};
		}
		/** One merged repaint queue (rAF-coalesced; callers just schedule). */
		var RepaintQueue = class {
			surface;
			getItems;
			root;
			queued = false;
			constructor(surface, getItems, root) {
				this.surface = surface;
				this.getItems = getItems;
				this.root = root;
			}
			/** Schedule one repaint; multiple schedules within a frame coalesce. */
			schedule() {
				if (this.queued) return;
				this.queued = true;
				requestAnimationFrame(() => {
					this.queued = false;
					this.surface.paint(this.getItems(), this.root);
				});
			}
		};
		//#endregion
		//#region src/client/panel.tsx
		/**
		* The annotation panel: mounted in the conversation.composer.dock slot
		* (the native band under the composer card). Renders the collapsible
		* 「批注 ×N」 list, the selection float bar (「批注」 button over assistant
		* text), the CSS-Highlight painting with rAF-merged repositioning, and the
		* chip↔item sync (a manually deleted chip is re-inserted and the panel
		* prompts the user to remove it from here instead).
		*/
		const MAX_NOTE_LENGTH = 4096;
		function AnnotationPanel({ sessionId, actx, registry, useInput, inputActions }) {
			const input = useInput((state) => state);
			const draft = registry.get(sessionId);
			const [open, setOpen] = (0, react.useState)(false);
			const [editingId, setEditingId] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)(null);
			const [movedIds, setMovedIds] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [float, setFloat] = (0, react.useState)(null);
			const overlayRef = (0, react.useRef)(null);
			const surfaceRef = (0, react.useRef)(null);
			const queueRef = (0, react.useRef)(null);
			const floatTargetRef = (0, react.useRef)(null);
			const locked = input.phase === "submitting" || input.phase === "adjudicating";
			(0, react.useEffect)(() => {
				const overlay = overlayRef.current;
				if (overlay === null) return;
				if (surfaceRef.current === null) {
					const surface = createHighlightSurface(overlay, typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : void 0);
					surfaceRef.current = surface;
					queueRef.current = new RepaintQueue(surface, () => registry.get(sessionId).items, document);
				}
				const repaint = () => {
					const located = queueRef.current === null ? surfaceRef.current.paint(registry.get(sessionId).items, document) : surfaceRef.current.paint(registry.get(sessionId).items, document);
					const next = new Set(registry.get(sessionId).items.map((item) => item.id).filter((id) => !located.some((l) => l.id === id)));
					setMovedIds((current) => {
						if (current.size === next.size && [...current].every((id) => next.has(id))) return current;
						return next;
					});
				};
				repaint();
				return () => {
					surfaceRef.current?.clear();
				};
			}, [
				sessionId,
				registry,
				input,
				draft.items
			]);
			(0, react.useEffect)(() => {
				const schedule = () => {
					queueRef.current?.schedule();
				};
				document.addEventListener("scroll", schedule, {
					capture: true,
					passive: true
				});
				window.addEventListener("resize", schedule);
				return () => {
					document.removeEventListener("scroll", schedule, { capture: true });
					window.removeEventListener("resize", schedule);
				};
			}, []);
			(0, react.useEffect)(() => {
				if (locked || actx === void 0) return;
				const present = new Set(input.occurrences.filter((o) => o.source === SOURCE).map((o) => o.ref));
				const missing = draft.items.filter((item) => !present.has(item.id));
				if (missing.length === 0) return;
				for (const item of missing) {
					const { reference, span } = chipInsert(item, draft.items.indexOf(item), input.draft.length, input.draftRev);
					actx.bail(actx, "slash/input-insert-reference", {
						reference,
						span
					});
				}
				setNotice(missing.length > 0 ? `已恢复 ${missing.length} 条被删除的批注引用；如需移除请从批注面板清除` : null);
			}, [
				actx,
				input.draft,
				input.draftRev,
				input.occurrences,
				input.phase,
				locked,
				draft.items
			]);
			(0, react.useEffect)(() => {
				let frame = 0;
				const onSelectionChange = () => {
					cancelAnimationFrame(frame);
					frame = requestAnimationFrame(() => {
						const selection = document.getSelection();
						if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
							setFloat(null);
							floatTargetRef.current = null;
							return;
						}
						const target = extractTarget(selection, document);
						if (target === null) {
							setFloat(null);
							floatTargetRef.current = null;
							return;
						}
						const rect = selection.getRangeAt(0).getBoundingClientRect();
						floatTargetRef.current = target;
						setFloat({
							x: rect.left + rect.width / 2,
							y: rect.top
						});
					});
				};
				document.addEventListener("selectionchange", onSelectionChange);
				return () => {
					document.removeEventListener("selectionchange", onSelectionChange);
					cancelAnimationFrame(frame);
				};
			}, []);
			const annotate = () => {
				const target = floatTargetRef.current;
				if (target === null) return;
				const item = registry.add(sessionId, target, "");
				if (item === null) {
					setNotice("批注已达上限（32 条）");
					return;
				}
				const { reference, span } = chipInsert(item, draft.items.indexOf(item), input.draft.length, input.draftRev);
				actx?.bail(actx, "slash/input-insert-reference", {
					reference,
					span
				});
				document.getSelection()?.removeAllRanges();
				setFloat(null);
				floatTargetRef.current = null;
				setOpen(true);
				setNotice(null);
			};
			const removeItem = (id) => {
				registry.remove(sessionId, id);
				const occurrence = input.occurrences.find((o) => o.source === "annotation" && o.ref === id);
				if (occurrence !== void 0 && inputActions !== void 0) inputActions.setDraft(input.draft.slice(0, occurrence.offset) + input.draft.slice(occurrence.offset + 1));
				if (editingId === id) setEditingId(null);
			};
			const clearAll = () => {
				registry.clear(sessionId);
				const occurrences = input.occurrences.filter((o) => o.source === SOURCE);
				if (occurrences.length > 0 && inputActions !== void 0) {
					let next = input.draft;
					for (let i = occurrences.length - 1; i >= 0; i -= 1) {
						const offset = occurrences[i].offset;
						next = next.slice(0, offset) + next.slice(offset + 1);
					}
					inputActions.setDraft(next);
				}
				setEditingId(null);
			};
			if (draft.items.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				ref: overlayRef,
				className: "dsh-ann2-overlay",
				"data-dsh-annotation-2": true
			}), float !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-ann2-floatbar",
				"data-dsh-annotation-2": true,
				style: {
					left: float.x,
					top: float.y
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: annotate,
					children: "批注"
				})
			})] });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-dsh-annotation-2": true,
				className: "dsh-ann2-panel",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						ref: overlayRef,
						className: "dsh-ann2-overlay"
					}),
					float !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-ann2-floatbar",
						style: {
							left: float.x,
							top: float.y
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: annotate,
							children: "批注"
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "dsh-ann2-panel-row",
						"data-expanded": open || void 0,
						onClick: () => {
							setOpen((value) => !value);
						},
						"aria-expanded": open,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-ann2-count",
							children: draft.items.length
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "批注" })]
					}),
					open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-ann2-body",
						children: [
							notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-ann2-moved",
								children: notice
							}),
							draft.items.map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AnnotationItemRow, {
								item,
								index,
								moved: movedIds.has(item.id),
								locked,
								editing: editingId === item.id,
								onEdit: () => {
									setEditingId(item.id);
								},
								onSave: (note) => {
									registry.update(sessionId, item.id, note.slice(0, MAX_NOTE_LENGTH));
									setEditingId(null);
								},
								onCancel: () => {
									setEditingId(null);
								},
								onRemove: () => {
									removeItem(item.id);
								}
							}, item.id)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									justifyContent: "flex-end",
									marginTop: 4
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-ann2-btn",
									onClick: clearAll,
									disabled: locked,
									children: "清空批注"
								})
							})
						]
					})
				]
			});
		}
		function AnnotationItemRow({ item, index, moved, locked, editing, onEdit, onSave, onCancel, onRemove }) {
			const [value, setValue] = (0, react.useState)(item.note);
			if (editing) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-ann2-item",
				"data-dsh-annotation-2": true,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-ann2-badge",
					children: index + 1
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
					className: "dsh-ann2-editor",
					value,
					rows: 3,
					autoFocus: true,
					onChange: (event) => {
						setValue(event.target.value);
					},
					onKeyDown: (event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							onSave(value);
						} else if (event.key === "Escape") {
							event.preventDefault();
							onCancel();
						}
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-ann2-actions",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsh-ann2-btn",
						"data-primary": true,
						onClick: () => {
							onSave(value);
						},
						children: "保存"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dsh-ann2-btn",
						onClick: onCancel,
						children: "取消"
					})]
				})] })]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-ann2-item",
				"data-dsh-annotation-2": true,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-ann2-badge",
						children: index + 1
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-ann2-quote",
							title: item.target.exact,
							children: item.target.exact
						}),
						item.note === "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-ann2-note",
							"data-empty": true,
							children: "（未填写）"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-ann2-note",
							children: item.note
						}),
						moved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-ann2-moved",
							children: "原文位置已变化（引用和批注仍可发送）"
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-ann2-toolbar",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-ann2-tool",
							disabled: locked,
							onClick: onEdit,
							title: "编辑批注",
							children: "编辑"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-ann2-tool",
							disabled: locked,
							onClick: onRemove,
							title: "删除批注",
							children: "删除"
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/session-registry.ts
		/**
		* Per-session annotation registry: in-memory drafts backed by localStorage,
		* with mutations always persisted (best-effort). One registry per plugin
		* apply; sessions materialize their draft on first access.
		*/
		function createSessionRegistry(storage) {
			const drafts = /* @__PURE__ */ new Map();
			const get = (sessionId) => {
				const existing = drafts.get(sessionId);
				if (existing !== void 0) return existing;
				const restored = loadDraft(sessionId, storage);
				drafts.set(sessionId, restored);
				return restored;
			};
			const apply = (sessionId, mutation) => {
				drafts.set(sessionId, mutation.draft);
				saveDraft(sessionId, mutation.draft, storage);
				return mutation.draft;
			};
			return {
				get,
				add(sessionId, target, note) {
					const draft = get(sessionId);
					const item = {
						id: crypto.randomUUID(),
						target,
						note
					};
					const mutation = addItem(draft, item);
					if (mutation === null) return null;
					apply(sessionId, mutation);
					return item;
				},
				update(sessionId, id, note) {
					apply(sessionId, updateNote(get(sessionId), id, note));
				},
				remove(sessionId, id) {
					apply(sessionId, removeItems(get(sessionId), [id]));
				},
				commit(sessionId, ids) {
					apply(sessionId, removeItems(get(sessionId), ids));
				},
				clear(sessionId) {
					apply(sessionId, clearItems(get(sessionId)));
				}
			};
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Plugin-owned styles, injected once at apply time. Scoped with a unique
		* prefix so hot reloads never double-apply (the tag is idempotent).
		*/
		const STYLE_ID = "dsh-annotation-2-style";
		const STYLE_TEXT = `
[data-dsh-annotation-2] { all: initial; }
[data-dsh-annotation-2] *, [data-dsh-annotation-2] *::before, [data-dsh-annotation-2] *::after { box-sizing: border-box; }
.dsh-ann2-panel { font-family: var(--dsw-font-family, system-ui); font-size: 12px; line-height: 1.5; }
.dsh-ann2-panel-row { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px; cursor: pointer; }
.dsh-ann2-panel-row:hover { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 60%, transparent); }
.dsh-ann2-panel-row[data-expanded] { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 60%, transparent); }
.dsh-ann2-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; font-size: 11px; font-weight: 600; color: #fff; background: var(--dsw-alias-accent, #5e9eff); }
.dsh-ann2-body { padding: 2px 8px 8px 26px; }
.dsh-ann2-item { display: grid; grid-template-columns: auto 1fr auto; gap: 6px 8px; align-items: start; padding: 6px 8px; border-radius: 8px; }
.dsh-ann2-item:hover { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 50%, transparent); }
.dsh-ann2-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 10px; font-weight: 600; color: #fff; background: var(--dsw-alias-accent, #5e9eff); }
.dsh-ann2-quote { color: var(--dsw-alias-text-secondary, #999); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ann2-note { white-space: pre-wrap; word-break: break-word; }
.dsh-ann2-note[data-empty] { color: var(--dsw-alias-text-tertiary, #666); font-style: italic; }
.dsh-ann2-moved { color: var(--dsw-alias-danger, #ff6b6b); font-size: 11px; }
.dsh-ann2-toolbar { display: flex; gap: 4px; }
.dsh-ann2-tool { border: none; background: transparent; color: var(--dsw-alias-text-secondary, #999); font-size: 12px; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
.dsh-ann2-tool:hover { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 60%, transparent); color: var(--dsw-alias-text-primary, #eee); }
.dsh-ann2-editor { width: 100%; min-height: 48px; resize: vertical; background: var(--dsw-alias-fill-input, #1c1c1e); color: var(--dsw-alias-text-primary, #eee); border: 1px solid var(--dsw-alias-border, #3a3a3c); border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 12px; }
.dsh-ann2-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; }
.dsh-ann2-btn { border: 1px solid var(--dsw-alias-border, #3a3a3c); background: transparent; color: var(--dsw-alias-text-primary, #eee); border-radius: 8px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
.dsh-ann2-btn:hover { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 60%, transparent); }
.dsh-ann2-btn[data-primary] { background: var(--dsw-alias-accent, #5e9eff); border-color: transparent; color: #fff; }
.dsh-ann2-floatbar { position: fixed; z-index: 1200; display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-inverted, #555); background: var(--dsw-specific-menu, #2c2c2e); box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.4)); font-family: var(--dsw-font-family, system-ui); }
.dsh-ann2-floatbar button { border: none; background: transparent; color: var(--dsw-alias-text-primary, #eee); font-size: 12px; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
.dsh-ann2-floatbar button:hover { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 60%, transparent); }
.dsh-ann2-overlay { position: fixed; z-index: 1199; pointer-events: none; }
.dsh-ann2-pin { position: absolute; transform: translate(-50%, -100%); display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 10px; font-weight: 600; color: #fff; background: var(--dsw-alias-accent, #5e9eff); pointer-events: auto; cursor: pointer; }
.dsh-ann2-chip-label { font-size: 10px; color: var(--dsw-alias-accent, #5e9eff); }
`;
		/** Inject the stylesheet once; returns the tag (no-op on re-entry). */
		function ensureStyles(root) {
			if (root.getElementById("dsh-annotation-2-style") !== null) return;
			const style = root.createElement("style");
			style.id = STYLE_ID;
			style.textContent = STYLE_TEXT;
			root.head.appendChild(style);
		}
		//#endregion
		//#region src/client/index.tsx
		/** Required services: session scopes, the slash roster, and the slot ledger. */
		const inject = [
			"sessions",
			"slash",
			"slots"
		];
		function apply(ctx) {
			ensureStyles(document);
			const registry = createSessionRegistry(localStorage);
			const source = createAnnotationSource(registry);
			ctx.effect(() => {
				const slash = ctx.get("slash");
				if (slash === void 0) return () => {};
				const dispose = slash.registerSource(source);
				return () => {
					dispose();
				};
			}, "dsh-annotation: @ source");
			ctx.inject(["slots", "sessions"], (scope) => {
				const sessions = scope.sessions;
				scope.slots.inject("conversation.composer.dock", () => scope.slots.register({
					name: "conversation.composer.dock",
					id: "dsh-annotation-2",
					order: 100,
					inject: (sessionId) => {
						return {
							sessionId: String(sessionId),
							actx: sessions.scope(sessionId),
							registry
						};
					}
				}, AnnotationPanel));
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map