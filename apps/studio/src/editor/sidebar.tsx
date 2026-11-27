'use client';

import { createId } from '@paralleldrive/cuid2';
import {
  DEFAULT_STRIP_OVERLAY_ASSET_ID,
  ELEMENT_ALLOWED_PAGES,
  RESPONSE_ELEMENT_TYPES,
  PAGE_TYPES,
  STATIC_ELEMENT_TYPES,
  defaultStripOverlayAsset,
  type Element,
  type ElementType,
  type Frame,
} from '@pb/schema';
import { cn } from '@pb/ui';
import { useState } from 'react';
import { ensureAssetRef } from './assets';
import {
  libraryAssetId,
  useApply,
  useCtx,
  useEditor,
  useEnv,
  useStore,
  type LibraryFrameItem,
} from './editor-context';
import { ELEMENT_LABEL, createElement } from './element-factory';
import { IconButton, Section } from './fields';
import { PAGE_LABEL, readableTokens } from './labels';
import {
  FRAME_ELEMENT_TYPES,
  addElements,
  addSlot,
  canvasSize,
  clone,
  elementsOf,
  frameOf,
  listsOf,
  moveToIndex,
  reorder,
  setFlag,
  shiftSlotOrder,
} from './operations';
import type { IssueGroups } from './validation';

// --- Pages ---------------------------------------------------------------------------------

export function PagesList({ issues }: { issues: IssueGroups }) {
  const store = useStore();
  const target = useEditor((s) => s.ui.target);
  const flow = useEditor((s) => s.doc.flow);
  const inactive = (p: string) =>
    (p === 'tutorial' && !flow.tutorialEnabled) ||
    (p === 'review' && !flow.reviewEnabled) ||
    (p === 'payment' && flow.eventMode);
  return (
    <Section title="Halaman">
      <ul className="space-y-0.5" data-testid="page-list">
        {PAGE_TYPES.map((p) => {
          const count = issues.byPage[p]?.length ?? 0;
          const active = target.kind === 'page' && target.page === p;
          return (
            <li key={p}>
              <button
                type="button"
                data-testid={`page-${p}`}
                onClick={() => store.setUi({ target: { kind: 'page', page: p }, selection: [] })}
                className={cn(
                  'flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-accent',
                  active && 'bg-accent font-medium',
                  inactive(p) && 'text-muted-foreground line-through',
                )}
              >
                <span>{PAGE_LABEL[p]}</span>
                {count > 0 && (
                  <span
                    className="rounded-full bg-destructive px-1.5 text-[10px] text-destructive-foreground"
                    title={`${count} masalah`}
                  >
                    {count}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// --- Tutorial slides -----------------------------------------------------------------------

export function SlidesBar() {
  const store = useStore();
  const apply = useApply();
  const slides = useEditor((s) => s.doc.pages.tutorial.slides) ?? [];
  const slideId = useEditor((s) => s.ui.slideId);
  const current = slides.find((s) => s.id === slideId);
  const pick = (id: string | null) => store.setUi({ slideId: id, selection: [] });
  return (
    <Section
      title="Slide"
      actions={
        <IconButton
          title="Tambah slide"
          testId="slide-add"
          onClick={() => {
            const id = createId();
            apply('Tambah slide', (d) => {
              (d.pages.tutorial.slides ??= []).push({ id, elements: [], durationSec: 5 });
            });
            pick(id);
          }}
        >
          +
        </IconButton>
      }
    >
      <div className="flex flex-wrap gap-1">
        {slides.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => pick(s.id)}
            className={cn(
              'h-7 min-w-7 rounded border px-2 text-xs',
              s.id === slideId && 'border-primary bg-accent',
            )}
          >
            {i + 1}
          </button>
        ))}
      </div>
      {current && (
        <div className="space-y-1 text-xs">
          <label className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Durasi (dtk, kosong = manual)</span>
            <input
              className="h-7 w-16 rounded border px-1"
              defaultValue={current.durationSec ?? ''}
              key={`${current.id}-${current.durationSec}`}
              onBlur={(e) => {
                const v = Number(e.target.value);
                apply('Durasi slide', (d) => {
                  const s = d.pages.tutorial.slides?.find((x) => x.id === current.id);
                  if (!s) return;
                  if (e.target.value.trim() === '' || !(v > 0)) delete s.durationSec;
                  else s.durationSec = v;
                });
              }}
            />
          </label>
          <div className="flex gap-1">
            <IconButton
              title="Duplikat slide"
              onClick={() => {
                const id = createId();
                apply('Duplikat slide', (d) => {
                  const list = d.pages.tutorial.slides!;
                  const i = list.findIndex((x) => x.id === current.id);
                  const copy = clone(list[i]!);
                  copy.id = id;
                  copy.elements = copy.elements.map((e) => ({ ...e, id: createId() }));
                  list.splice(i + 1, 0, copy);
                });
                pick(id);
              }}
            >
              Duplikat
            </IconButton>
            <IconButton
              title="Geser ke kiri"
              onClick={() =>
                apply('Urutan slide', (d) => {
                  const list = d.pages.tutorial.slides!;
                  const i = list.findIndex((x) => x.id === current.id);
                  if (i > 0) [list[i - 1], list[i]] = [list[i]!, list[i - 1]!];
                })
              }
            >
              ←
            </IconButton>
            <IconButton
              title="Hapus slide"
              testId="slide-delete"
              onClick={() => {
                const rest = slides.filter((s) => s.id !== current.id);
                apply('Hapus slide', (d) => {
                  const list = d.pages.tutorial.slides!;
                  list.splice(
                    list.findIndex((x) => x.id === current.id),
                    1,
                  );
                });
                pick(rest[0]?.id ?? null);
              }}
            >
              Hapus
            </IconButton>
          </div>
        </div>
      )}
    </Section>
  );
}

// --- Add element ---------------------------------------------------------------------------

const isResponseType = (t: ElementType) =>
  (RESPONSE_ELEMENT_TYPES as readonly string[]).includes(t);

export function AddElementMenu() {
  const store = useStore();
  const ctx = useCtx();
  const doc = useEditor((s) => s.doc);
  const [open, setOpen] = useState(false);
  const isTutorial = ctx.target.kind === 'page' && ctx.target.page === 'tutorial';

  const types: ElementType[] =
    ctx.target.kind === 'frame'
      ? [...FRAME_ELEMENT_TYPES]
      : (Object.keys(ELEMENT_LABEL) as ElementType[]).filter((t) => {
          const allowed = ELEMENT_ALLOWED_PAGES[t];
          return !allowed || (ctx.target.kind === 'page' && allowed.includes(ctx.target.page));
        });
  const groups: [string, ElementType[]][] = [
    ['Statis', types.filter((t) => (STATIC_ELEMENT_TYPES as readonly string[]).includes(t))],
    ['Interaktif', types.filter((t) => t === 'button')],
    ['Persetujuan & survei', types.filter(isResponseType)],
    [
      'Khusus',
      types.filter(
        (t) =>
          t !== 'button' &&
          !isResponseType(t) &&
          !(STATIC_ELEMENT_TYPES as readonly string[]).includes(t),
      ),
    ],
  ];

  const add = (type: ElementType) => {
    const size = canvasSize(doc, ctx);
    const used = new Set(
      elementsOf(doc, ctx)
        .filter((e) => e.type === 'photo-slot')
        .map((e) => (e as Extract<Element, { type: 'photo-slot' }>).slotIndex),
    );
    let slotIndex = 1;
    while (used.has(slotIndex)) slotIndex++;
    const firstImage = doc.assets.find((a) => a.kind === 'image');
    const el = createElement(type, doc, {
      center: { x: size.width / 2, y: size.height / 2 },
      slotIndex,
      assetId: type === 'image' ? firstImage?.id : undefined,
      scale: ctx.target.kind === 'frame' ? 0.5 : 1,
    });
    let added: string[] = [];
    store.apply(`Tambah ${ELEMENT_LABEL[type]}`, (d) => {
      added = addElements(d, ctx, [el]);
    });
    store.setUi({ selection: added });
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="add-element"
        className="h-8 w-full rounded bg-primary px-2 text-xs font-medium text-primary-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        + Tambah elemen
      </button>
      {open && (
        <div
          className="absolute left-0 right-0 z-20 mt-1 max-h-96 overflow-auto rounded border bg-background p-2 shadow-lg"
          data-testid="add-element-menu"
        >
          {groups.map(
            ([title, list]) =>
              list.length > 0 && (
                <div key={title} className="mb-2">
                  <div className="mb-1 text-[10px] uppercase text-muted-foreground">{title}</div>
                  <div className="grid grid-cols-2 gap-1">
                    {list.map((t) => (
                      <button
                        key={t}
                        type="button"
                        data-testid={`add-${t}`}
                        className="rounded border px-2 py-1 text-left text-xs hover:bg-accent"
                        onClick={() => add(t)}
                      >
                        {ELEMENT_LABEL[t]}
                      </button>
                    ))}
                  </div>
                </div>
              ),
          )}
          {isTutorial && (
            <p className="text-[10px] text-muted-foreground">Elemen statis masuk ke slide aktif.</p>
          )}
        </div>
      )}
    </div>
  );
}

// --- Layers --------------------------------------------------------------------------------

export function LayersPanel() {
  const store = useStore();
  const apply = useApply();
  const ctx = useCtx();
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.ui.selection);
  const lists = listsOf(doc, ctx);
  const [dragId, setDragId] = useState<string | null>(null);
  const frame = frameOf(doc, ctx);

  const click = (id: string, shift: boolean) => {
    const sel = store.getState().ui.selection;
    store.setUi({
      selection: shift ? (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]) : [id],
    });
  };

  return (
    <Section
      title="Layer"
      actions={
        <div className="flex">
          <IconButton
            title="Maju (Ctrl+])"
            disabled={!selection.length}
            onClick={() => apply('Maju', (d, c) => reorder(d, c, selection, 'forward'))}
          >
            ↑
          </IconButton>
          <IconButton
            title="Mundur (Ctrl+[)"
            disabled={!selection.length}
            onClick={() => apply('Mundur', (d, c) => reorder(d, c, selection, 'backward'))}
          >
            ↓
          </IconButton>
          <IconButton
            title="Paling depan"
            disabled={!selection.length}
            onClick={() => apply('Ke depan', (d, c) => reorder(d, c, selection, 'front'))}
          >
            ⤒
          </IconButton>
          <IconButton
            title="Paling belakang"
            disabled={!selection.length}
            onClick={() => apply('Ke belakang', (d, c) => reorder(d, c, selection, 'back'))}
          >
            ⤓
          </IconButton>
        </div>
      }
    >
      <ul className="space-y-0.5 text-xs" data-testid="layer-list">
        {lists.map((list, li) => (
          <li key={li}>
            {lists.length > 1 && (
              <div className="px-1 pt-1 text-[10px] uppercase text-muted-foreground">
                {li === 0 ? 'Slide' : 'Halaman'}
              </div>
            )}
            <ul>
              {[...list].reverse().map((el) => {
                const index = list.indexOf(el);
                return (
                  <li
                    key={el.id}
                    draggable
                    data-testid={`layer-${el.id}`}
                    onDragStart={() => setDragId(el.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId && dragId !== el.id && list.some((x) => x.id === dragId)) {
                        apply('Urutan layer', (d, c) => moveToIndex(d, c, dragId, index));
                      }
                      setDragId(null);
                    }}
                    onClick={(e) => click(el.id, e.shiftKey)}
                    className={cn(
                      'flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent',
                      selection.includes(el.id) && 'bg-primary/15',
                      !el.visible && 'opacity-50',
                    )}
                  >
                    <span className="cursor-grab text-muted-foreground">⋮⋮</span>
                    {el.groupId && (
                      <span className="text-[9px] text-primary" title="Group">
                        ▣
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {el.name ? readableTokens(el.name) : ELEMENT_LABEL[el.type]}
                    </span>
                    <button
                      type="button"
                      title={el.visible ? 'Sembunyikan' : 'Tampilkan'}
                      data-testid={`layer-visible-${el.id}`}
                      className="px-1 text-muted-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        apply(el.visible ? 'Sembunyikan' : 'Tampilkan', (d, c) =>
                          setFlag(d, c, [el.id], 'visible', !el.visible),
                        );
                      }}
                    >
                      {el.visible ? '👁' : '–'}
                    </button>
                    <button
                      type="button"
                      title={el.locked ? 'Buka kunci' : 'Kunci'}
                      data-testid={`layer-lock-${el.id}`}
                      className="px-1 text-muted-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        apply(el.locked ? 'Buka kunci' : 'Kunci', (d, c) =>
                          setFlag(d, c, [el.id], 'locked', !el.locked),
                        );
                      }}
                    >
                      {el.locked ? '🔒' : '🔓'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
        {frame && (
          <li>
            <div className="px-1 pt-1 text-[10px] uppercase text-muted-foreground">
              Slot foto (urutan ambil)
            </div>
            <ul>
              {frame.slots.map((s) => (
                <li
                  key={s.index}
                  data-testid={`layer-slot-${s.index}`}
                  onClick={(e) => click(`slot:${s.index}`, e.shiftKey)}
                  className={cn(
                    'flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent',
                    selection.includes(`slot:${s.index}`) && 'bg-primary/15',
                  )}
                >
                  <span className="flex-1">Slot {s.index}</span>
                  <button
                    type="button"
                    className="px-1"
                    title="Lebih awal"
                    onClick={(e) => {
                      e.stopPropagation();
                      apply('Urutan slot', (d, c) => shiftSlotOrder(d, c, s.index, -1), {
                        selectAfter: [`slot:${s.index - 1}`],
                      });
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="px-1"
                    title="Lebih akhir"
                    onClick={(e) => {
                      e.stopPropagation();
                      apply('Urutan slot', (d, c) => shiftSlotOrder(d, c, s.index, 1), {
                        selectAfter: [`slot:${s.index + 1}`],
                      });
                    }}
                  >
                    ↓
                  </button>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
    </Section>
  );
}

// --- Frames --------------------------------------------------------------------------------

export function FramesList({ issues }: { issues: IssueGroups }) {
  const store = useStore();
  const apply = useApply();
  const env = useEnv();
  const frames = useEditor((s) => s.doc.frames);
  const target = useEditor((s) => s.ui.target);
  const atLimit = env.maxFrames !== null && frames.length >= env.maxFrames;
  const open = (id: string) =>
    store.setUi({ target: { kind: 'frame', frameId: id }, selection: [] });
  const sorted = [...frames].sort((a, b) => a.sortOrder - b.sortOrder);

  const addFrame = () => {
    const id = createId();
    const base = frames[0];
    apply('Tambah frame', (d) => {
      ensureAssetRef(d, defaultStripOverlayAsset());
      const frame: Frame = {
        id,
        name: `Frame ${frames.length + 1}`,
        thumbnailAssetId: DEFAULT_STRIP_OVERLAY_ASSET_ID,
        overlayAssetId: DEFAULT_STRIP_OVERLAY_ASSET_ID,
        slots: base ? clone(base.slots) : [],
        dynamicElements: [],
        enabled: true,
        sortOrder: Math.max(0, ...frames.map((f) => f.sortOrder)) + 1,
      };
      d.frames.push(frame);
    });
    open(id);
  };

  const [showLibrary, setShowLibrary] = useState(false);
  const addFromLibrary = (lib: LibraryFrameItem) => {
    const id = createId();
    const assetId = libraryAssetId(lib.id);
    apply('Frame dari pustaka', (d) => {
      ensureAssetRef(d, {
        id: assetId,
        kind: 'image',
        url: lib.url,
        sha256: lib.sha256,
        bytes: lib.bytes,
      });
      d.frames.push({
        id,
        name: lib.name.slice(0, 120),
        thumbnailAssetId: assetId,
        overlayAssetId: assetId,
        slots: clone(lib.slots),
        dynamicElements: [],
        enabled: true,
        sortOrder: Math.max(0, ...d.frames.map((f) => f.sortOrder)) + 1,
      });
    });
    setShowLibrary(false);
    open(id);
  };

  return (
    <Section
      title="Frame"
      actions={
        <>
          <IconButton
            title={
              atLimit
                ? `Batas paket: ${env.maxFrames} frame`
                : env.libraryFrames.length
                  ? 'Tambah dari pustaka frame'
                  : 'Pustaka frame masih kosong'
            }
            testId="frame-library"
            disabled={atLimit || env.libraryFrames.length === 0}
            onClick={() => setShowLibrary((v) => !v)}
          >
            ▦
          </IconButton>
          <IconButton
            title={atLimit ? `Batas paket: ${env.maxFrames} frame` : 'Tambah frame kosong'}
            testId="frame-add"
            disabled={atLimit}
            onClick={addFrame}
          >
            +
          </IconButton>
        </>
      }
    >
      {showLibrary && !atLimit && (
        <div
          className="space-y-1 rounded border bg-background p-2"
          data-testid="frame-library-list"
        >
          <div className="flex items-center justify-between text-[11px] font-medium">
            <span>Pustaka frame</span>
            <button
              type="button"
              className="text-muted-foreground"
              onClick={() => setShowLibrary(false)}
            >
              Tutup
            </button>
          </div>
          <div className="grid max-h-72 grid-cols-3 gap-1 overflow-auto">
            {env.libraryFrames.map((lib) => (
              <button
                key={lib.id}
                type="button"
                title={`${lib.name} · ${lib.slots.length} foto`}
                data-testid="frame-library-item"
                className="flex flex-col items-center gap-0.5 rounded border p-1 text-[10px] hover:border-primary"
                onClick={() => addFromLibrary(lib)}
              >
                <img
                  src={lib.url}
                  alt={lib.name}
                  className="h-24 w-full bg-[repeating-conic-gradient(#e5e7eb_0%_25%,#fff_0%_50%)] bg-[length:8px_8px] object-contain"
                />
                <span className="w-full truncate">{lib.name}</span>
                <span className="text-muted-foreground">{lib.slots.length} foto</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {atLimit && (
        <p className="rounded bg-amber-50 p-2 text-[11px] text-amber-800" data-testid="frame-limit">
          Paket Anda dibatasi {env.maxFrames} frame. Upgrade paket untuk menambah frame.
        </p>
      )}
      <ul className="space-y-0.5 text-xs" data-testid="frame-list">
        {sorted.map((f, i) => {
          const active = target.kind === 'frame' && target.frameId === f.id;
          const count = issues.byFrame[f.id]?.length ?? 0;
          return (
            <li
              key={f.id}
              className={cn(
                'flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent',
                active && 'bg-accent font-medium',
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => open(f.id)}
              >
                {f.name} {!f.enabled && <span className="text-muted-foreground">(nonaktif)</span>}
              </button>
              {count > 0 && (
                <span className="rounded-full bg-destructive px-1.5 text-[10px] text-destructive-foreground">
                  {count}
                </span>
              )}
              <button
                type="button"
                className="px-1 text-muted-foreground"
                title="Naik"
                disabled={i === 0}
                onClick={() =>
                  apply('Urutan frame', (d) => {
                    const a = d.frames.find((x) => x.id === f.id)!;
                    const b = d.frames.find((x) => x.id === sorted[i - 1]!.id)!;
                    [a.sortOrder, b.sortOrder] = [b.sortOrder, a.sortOrder];
                    if (a.sortOrder === b.sortOrder) a.sortOrder -= 1;
                  })
                }
              >
                ↑
              </button>
              <button
                type="button"
                className="px-1 text-muted-foreground"
                title="Duplikat"
                disabled={atLimit}
                onClick={() => {
                  const id = createId();
                  apply('Duplikat frame', (d) => {
                    const src = d.frames.find((x) => x.id === f.id)!;
                    const copy = clone(src);
                    copy.id = id;
                    copy.name = `${src.name} (salinan)`;
                    copy.sortOrder = Math.max(...d.frames.map((x) => x.sortOrder)) + 1;
                    copy.dynamicElements = copy.dynamicElements.map((e) => ({
                      ...e,
                      id: createId(),
                    }));
                    d.frames.push(copy);
                  });
                  open(id);
                }}
              >
                ⧉
              </button>
              <button
                type="button"
                className="px-1 text-muted-foreground"
                title="Hapus"
                disabled={frames.length <= 1}
                onClick={() => {
                  apply('Hapus frame', (d) => {
                    d.frames.splice(
                      d.frames.findIndex((x) => x.id === f.id),
                      1,
                    );
                  });
                  store.setUi({ target: { kind: 'page', page: 'framePick' }, selection: [] });
                }}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      {target.kind === 'frame' && (
        <IconButton
          title="Tambah slot foto"
          testId="slot-add"
          onClick={() => {
            let idx: number | null = null;
            apply('Tambah slot', (d, c) => {
              idx = addSlot(d, c);
            });
            if (idx) store.setUi({ selection: [`slot:${idx}`] });
          }}
        >
          + Slot foto
        </IconButton>
      )}
    </Section>
  );
}
