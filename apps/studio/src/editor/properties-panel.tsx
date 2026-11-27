'use client';

import { createId } from '@paralleldrive/cuid2';
import {
  type Background,
  type BoothConfig,
  type ButtonAction,
  type Element,
  type ElementOf,
  type PageType,
  type Transition,
} from '@pb/schema';
import type { Draft } from 'immer';
import { AssetField, ensureAssetRef } from './assets';
import { useApply, useCtx, useEditor, useEnv, type AssetItem } from './editor-context';
import { ELEMENT_LABEL } from './element-factory';
import {
  ColorField,
  Grid2,
  IconButton,
  NumberField,
  Row,
  Section,
  SelectField,
  TextField,
  Toggle,
} from './fields';
import {
  align,
  distribute,
  frameOf,
  groupElements,
  locate,
  ungroupElements,
  updateElement,
  updateSlot,
  type AlignMode,
} from './operations';
import { AnimationFields, BoxStyleFields, TextStyleFields } from './style-fields';
import { PAGE_LABEL } from './labels';

export function PropertiesPanel() {
  const selection = useEditor((s) => s.ui.selection);
  const target = useEditor((s) => s.ui.target);
  const doc = useEditor((s) => s.doc);
  const ctx = useCtx();

  if (selection.length > 1) return <MultiSelection ids={selection} />;
  if (selection.length === 1) {
    const key = selection[0]!;
    if (key.startsWith('slot:')) return <SlotProps index={Number(key.slice(5))} />;
    const hit = locate(doc, ctx, key);
    if (hit) return <ElementProps el={hit.el} />;
  }
  if (target.kind === 'frame') return <FrameProps />;
  return <PageProps page={target.page} />;
}

// --- Multi-selection -------------------------------------------------------------------------

function MultiSelection({ ids }: { ids: string[] }) {
  const apply = useApply();
  const doAlign = (mode: AlignMode) => apply('Ratakan', (d, ctx) => align(d, ctx, ids, mode));
  return (
    <div>
      <Section title={`${ids.length} dipilih`}>
        <div className="grid grid-cols-6 gap-1" data-testid="align-buttons">
          {(
            [
              ['left', '⇤'],
              ['hcenter', '↔'],
              ['right', '⇥'],
              ['top', '⤒'],
              ['vcenter', '↕'],
              ['bottom', '⤓'],
            ] as const
          ).map(([mode, glyph]) => (
            <IconButton
              key={mode}
              title={`Ratakan ${mode}`}
              testId={`align-${mode}`}
              onClick={() => doAlign(mode)}
            >
              {glyph}
            </IconButton>
          ))}
        </div>
        <div className="flex gap-1">
          <IconButton
            title="Sebar horizontal"
            testId="distribute-h"
            disabled={ids.length < 3}
            onClick={() => apply('Sebar', (d, ctx) => distribute(d, ctx, ids, 'horizontal'))}
          >
            Sebar ↔
          </IconButton>
          <IconButton
            title="Sebar vertikal"
            testId="distribute-v"
            disabled={ids.length < 3}
            onClick={() => apply('Sebar', (d, ctx) => distribute(d, ctx, ids, 'vertical'))}
          >
            Sebar ↕
          </IconButton>
        </div>
        <div className="flex gap-1">
          <IconButton
            title="Group (Ctrl+G)"
            onClick={() =>
              apply(
                'Group',
                (d, ctx) =>
                  void groupElements(
                    d,
                    ctx,
                    ids.filter((i) => !i.startsWith('slot:')),
                  ),
              )
            }
          >
            Group
          </IconButton>
          <IconButton
            title="Ungroup (Ctrl+Shift+G)"
            onClick={() => apply('Ungroup', (d, ctx) => ungroupElements(d, ctx, ids))}
          >
            Ungroup
          </IconButton>
        </div>
      </Section>
    </div>
  );
}

// --- Single element --------------------------------------------------------------------------

function useElementUpdate(id: string) {
  const apply = useApply();
  return (field: string, patch: Record<string, unknown>, extra?: (d: Draft<BoothConfig>) => void) =>
    apply(
      `Ubah ${field}`,
      (d, ctx) => {
        updateElement(d, ctx, id, patch);
        extra?.(d);
      },
      { coalesceKey: `prop:${id}:${field}` },
    );
}

function GeometrySection({ el }: { el: Element }) {
  const update = useElementUpdate(el.id);
  return (
    <Section title="Posisi & ukuran">
      <Grid2>
        <NumberField
          compact
          label="X"
          testId="prop-x"
          value={el.x}
          onCommit={(x) => update('X', { x })}
        />
        <NumberField
          compact
          label="Y"
          testId="prop-y"
          value={el.y}
          onCommit={(y) => update('Y', { y })}
        />
        <NumberField
          compact
          label="Lebar"
          hint="Lebar (px artboard)"
          testId="prop-w"
          value={el.width}
          min={1}
          onCommit={(width) => update('lebar', { width })}
        />
        <NumberField
          compact
          label="Tinggi"
          hint="Tinggi (px artboard)"
          testId="prop-h"
          value={el.height}
          min={1}
          onCommit={(height) => update('tinggi', { height })}
        />
      </Grid2>
      <Grid2>
        <NumberField
          compact
          label="Rotasi"
          hint="Rotasi (derajat)"
          testId="prop-rotation"
          value={el.rotation}
          onCommit={(rotation) => update('rotasi', { rotation })}
        />
        <NumberField
          compact
          label="Opasitas"
          hint="Opasitas (0 = transparan, 1 = penuh)"
          value={el.opacity}
          min={0}
          max={1}
          step={0.05}
          onCommit={(opacity) => update('opacity', { opacity })}
        />
      </Grid2>
    </Section>
  );
}

function ElementProps({ el }: { el: Element }) {
  const update = useElementUpdate(el.id);
  return (
    <div data-testid="element-props">
      <Section title={ELEMENT_LABEL[el.type]}>
        <TextField label="Nama" value={el.name} onCommit={(name) => update('nama', { name })} />
        <Grid2>
          <Toggle
            label="Terlihat"
            value={el.visible}
            onCommit={(visible) => update('visible', { visible })}
          />
          <Toggle
            label="Kunci"
            value={el.locked}
            onCommit={(locked) => update('lock', { locked })}
          />
        </Grid2>
      </Section>
      <GeometrySection el={el} />
      <TypeSection el={el} update={update} />
      {hasBoxStyle(el) && (
        <Section title="Kotak">
          <BoxStyleFields value={el.style} onChange={(style) => update('gaya', { style })} />
        </Section>
      )}
      <Section title="Animasi">
        <AnimationFields
          value={el.animation}
          onChange={(animation) => update('animasi', { animation })}
        />
      </Section>
    </div>
  );
}

const hasBoxStyle = (el: Element) => el.type !== 'photo-slot';

type Update = ReturnType<typeof useElementUpdate>;

function TypeSection({ el, update }: { el: Element; update: Update }) {
  switch (el.type) {
    case 'text':
      return <TextProps el={el} update={update} />;
    case 'image':
      return (
        <Section title="Gambar">
          <AssetField
            label="File"
            kind="image"
            value={el.assetId}
            onPick={(a) => a && update('gambar', { assetId: a.id }, (d) => ensureAssetRef(d, a))}
          />
          <SelectField
            label="Fit"
            value={el.fit}
            options={[
              { value: 'contain', label: 'Contain' },
              { value: 'cover', label: 'Cover' },
              { value: 'fill', label: 'Fill' },
            ]}
            onCommit={(fit) => update('fit', { fit })}
          />
        </Section>
      );
    case 'video':
      return (
        <Section title="Video">
          <AssetField
            label="File"
            kind="video"
            value={el.assetId}
            onPick={(a) => a && update('video', { assetId: a.id }, (d) => ensureAssetRef(d, a))}
          />
          <Toggle label="Ulang" value={el.loop} onCommit={(loop) => update('loop', { loop })} />
          <Toggle
            label="Tanpa suara"
            value={el.muted}
            onCommit={(muted) => update('muted', { muted })}
          />
        </Section>
      );
    case 'shape':
      return (
        <Section title="Bentuk">
          <SelectField
            label="Jenis"
            value={el.shape}
            options={[
              { value: 'rect', label: 'Persegi' },
              { value: 'ellipse', label: 'Elips' },
              { value: 'line', label: 'Garis' },
            ]}
            onCommit={(shape) => update('bentuk', { shape })}
          />
        </Section>
      );
    case 'button':
      return <ButtonProps el={el} update={update} />;
    case 'camera-view':
      return (
        <Section title="Kamera">
          <Toggle
            label="Mirror"
            value={el.mirror}
            onCommit={(mirror) => update('mirror', { mirror })}
          />
          <SelectField
            label="Fit"
            value={el.fit}
            options={[
              { value: 'cover', label: 'Cover' },
              { value: 'contain', label: 'Contain' },
            ]}
            onCommit={(fit) => update('fit', { fit })}
          />
          <Toggle
            label="Panduan crop"
            value={!!el.cropAspect}
            onCommit={(cropAspect) => update('crop', { cropAspect })}
          />
          <Toggle
            label="Overlay frame"
            value={el.overlayFrame}
            onCommit={(overlayFrame) => update('overlay', { overlayFrame })}
          />
        </Section>
      );
    case 'photo-slot':
      return <PhotoSlotProps el={el} update={update} />;
    case 'countdown':
      return (
        <Section title="Hitung mundur">
          <SelectField
            label="Gaya"
            value={el.variant}
            options={[
              { value: 'number', label: 'Angka' },
              { value: 'ring', label: 'Cincin' },
            ]}
            onCommit={(variant) => update('gaya', { variant })}
          />
          <NumberField
            label="Ukuran"
            value={el.fontSize}
            min={1}
            onCommit={(fontSize) => update('ukuran', { fontSize })}
          />
          <ColorField
            label="Warna"
            value={el.color}
            onCommit={(color) => color && update('warna', { color })}
          />
        </Section>
      );
    case 'frame-picker':
      return (
        <Section title="Pilihan frame">
          <SelectField
            label="Tata letak"
            value={el.layout}
            options={[
              { value: 'grid', label: 'Grid' },
              { value: 'carousel', label: 'Carousel' },
            ]}
            onCommit={(layout) => update('layout', { layout })}
          />
          <Grid2>
            <NumberField
              compact
              label="Kolom"
              hint="Jumlah kolom"
              value={el.columns}
              min={1}
              max={12}
              onCommit={(columns) => update('kolom', { columns: Math.round(columns) })}
            />
            <NumberField
              compact
              label="Jarak"
              hint="Jarak antar item (px)"
              value={el.gap}
              min={0}
              onCommit={(gap) => update('gap', { gap })}
            />
          </Grid2>
          <Toggle
            label="Tampilkan nama"
            value={el.showName}
            onCommit={(showName) => update('nama', { showName })}
          />
          <Toggle
            label="Tampilkan harga"
            value={el.showPrice}
            onCommit={(showPrice) => update('harga', { showPrice })}
          />
          <h4 className="pt-1 text-[11px] text-muted-foreground">Item</h4>
          <BoxStyleFields
            value={el.itemStyle}
            onChange={(itemStyle) => update('item', { itemStyle: itemStyle ?? {} })}
          />
          <h4 className="pt-1 text-[11px] text-muted-foreground">Terpilih</h4>
          <BoxStyleFields
            value={el.selectedStyle}
            onChange={(selectedStyle) => update('terpilih', { selectedStyle: selectedStyle ?? {} })}
          />
          {el.labelStyle && (
            <TextStyleFields
              value={el.labelStyle}
              onChange={(labelStyle) => update('label', { labelStyle })}
            />
          )}
        </Section>
      );
    case 'frame-preview':
      return (
        <Section title="Pratinjau frame">
          <SelectField
            label="Fit"
            value={el.fit}
            options={[
              { value: 'contain', label: 'Contain' },
              { value: 'cover', label: 'Cover' },
            ]}
            onCommit={(fit) => update('fit', { fit })}
          />
        </Section>
      );
    case 'filter-picker':
      return (
        <Section title="Pilihan filter">
          <SelectField
            label="Tata letak"
            value={el.layout}
            options={[
              { value: 'row', label: 'Baris' },
              { value: 'grid', label: 'Grid' },
            ]}
            onCommit={(layout) => update('layout', { layout })}
          />
          <NumberField
            label="Ukuran item"
            value={el.itemSize}
            min={20}
            onCommit={(itemSize) => update('ukuran', { itemSize })}
          />
          <Toggle
            label="Label"
            value={el.showLabel}
            onCommit={(showLabel) => update('label', { showLabel })}
          />
          <BoxStyleFields
            value={el.selectedStyle}
            onChange={(selectedStyle) => update('terpilih', { selectedStyle: selectedStyle ?? {} })}
            fillLabel="Isi terpilih"
          />
          {el.labelStyle && (
            <TextStyleFields
              value={el.labelStyle}
              onChange={(labelStyle) => update('label', { labelStyle })}
            />
          )}
        </Section>
      );
    case 'qris':
      return (
        <Section title="QRIS">
          <NumberField
            label="Padding"
            value={el.padding}
            min={0}
            onCommit={(padding) => update('padding', { padding })}
          />
          <ColorField
            label="Latar"
            value={el.background}
            onCommit={(background) => background && update('latar', { background })}
          />
          <Toggle
            label="Logo QRIS"
            value={el.showLogo}
            onCommit={(showLogo) => update('logo', { showLogo })}
          />
        </Section>
      );
    case 'download-qr':
      return (
        <Section title="QR unduh">
          <NumberField
            label="Padding"
            value={el.padding}
            min={0}
            onCommit={(padding) => update('padding', { padding })}
          />
          <ColorField
            label="Warna QR"
            value={el.foreground}
            onCommit={(foreground) => foreground && update('warna', { foreground })}
          />
          <ColorField
            label="Latar"
            value={el.background}
            onCommit={(background) => background && update('latar', { background })}
          />
        </Section>
      );
    case 'price-label':
      return (
        <Section title="Harga">
          <SelectField
            label="Format"
            value={el.format}
            options={[
              { value: 'idr', label: 'Rp 35.000' },
              { value: 'number', label: '35.000' },
            ]}
            onCommit={(format) => update('format', { format })}
          />
          <TextStyleFields value={pickText(el)} onChange={(ts) => update('teks', ts)} />
        </Section>
      );
    case 'payment-timer':
      return (
        <Section title="Timer">
          <SelectField
            label="Gaya"
            value={el.variant}
            options={[
              { value: 'text', label: 'Teks' },
              { value: 'bar', label: 'Bar' },
            ]}
            onCommit={(variant) => update('gaya', { variant })}
          />
          {el.variant === 'bar' ? (
            <>
              <ColorField
                label="Bar"
                value={el.barColor}
                allowEmpty
                onCommit={(barColor) => update('bar', { barColor })}
              />
              <ColorField
                label="Track"
                value={el.trackColor}
                allowEmpty
                onCommit={(trackColor) => update('track', { trackColor })}
              />
            </>
          ) : (
            el.textStyle && (
              <TextStyleFields
                value={el.textStyle}
                onChange={(textStyle) => update('teks', { textStyle })}
              />
            )
          )}
        </Section>
      );
    case 'voucher-input':
      return (
        <Section title="Voucher">
          <SelectField
            label="Gaya"
            value={el.variant}
            options={[
              { value: 'field', label: 'Kolom saja' },
              { value: 'keypad', label: 'Kolom + keypad (satu kotak)' },
            ]}
            onCommit={(variant) => update('gaya', { variant })}
          />
          {el.variant === 'field' && (
            <p className="text-[11px] text-muted-foreground">
              Tombol angka diatur terpisah lewat elemen Keypad voucher (+ Tambah elemen).
            </p>
          )}
          <TextStyleFields
            value={el.textStyle}
            onChange={(textStyle) => update('teks', { textStyle })}
          />
          <BoxStyleFields
            fillLabel="Isi kolom"
            value={el.keyStyle}
            onChange={(keyStyle) => update('gaya kolom', { keyStyle })}
          />
        </Section>
      );
    case 'voucher-keypad':
      return (
        <Section title="Keypad voucher">
          <NumberField
            label="Jarak tombol"
            hint="Jarak antar tombol (px artboard)"
            value={el.gap}
            min={0}
            onCommit={(gap) => update('jarak tombol', { gap })}
          />
          <TextStyleFields
            value={el.textStyle}
            onChange={(textStyle) => update('teks', { textStyle })}
          />
          <BoxStyleFields
            fillLabel="Isi tombol"
            value={el.keyStyle}
            onChange={(keyStyle) => update('gaya tombol', { keyStyle })}
          />
        </Section>
      );
    case 'progress':
      return (
        <Section title="Progres">
          <SelectField
            label="Gaya"
            value={el.variant}
            options={[
              { value: 'bar', label: 'Bar' },
              { value: 'spinner', label: 'Spinner' },
              { value: 'steps', label: 'Langkah' },
            ]}
            onCommit={(variant) => update('gaya', { variant })}
          />
          <ColorField
            label="Warna"
            value={el.color}
            onCommit={(color) => color && update('warna', { color })}
          />
          <ColorField
            label="Track"
            value={el.trackColor}
            allowEmpty
            onCommit={(trackColor) => update('track', { trackColor })}
          />
        </Section>
      );
    case 'print-copies':
      return (
        <Section title="Jumlah cetak">
          <TextStyleFields
            value={el.textStyle}
            onChange={(textStyle) => update('teks', { textStyle })}
          />
          <BoxStyleFields
            value={el.buttonStyle}
            onChange={(buttonStyle) => update('tombol', { buttonStyle })}
            fillLabel="Tombol"
          />
        </Section>
      );
    case 'consent-checkbox':
      return <ConsentProps el={el} update={update} />;
    case 'survey-question':
      return <SurveyProps el={el} update={update} />;
    case 'contact-input':
      return <ContactInputProps el={el} update={update} />;
  }
}

function ContactInputProps({ el, update }: { el: ElementOf<'contact-input'>; update: Update }) {
  return (
    <Section title="Kirim hasil">
      <SelectField
        label="Kirim lewat"
        value={el.channel}
        options={[
          { value: 'whatsapp', label: 'WhatsApp (keypad angka)' },
          { value: 'email', label: 'E-mail (keyboard huruf)' },
        ]}
        onCommit={(channel) =>
          update('saluran', {
            channel,
            placeholder: channel === 'whatsapp' ? 'Nomor WhatsApp' : 'Alamat e-mail',
          })
        }
      />
      <p className="text-xs text-muted-foreground">
        Pembeli mengetik nomor/e-mail lalu menekan tombol kirim; link unduhan dikirim platform
        begitu booth online. Maksimal 3 kiriman per sesi.
      </p>
      <TextField
        label="Teks petunjuk"
        value={el.placeholder}
        onCommit={(placeholder) => update('teks petunjuk', { placeholder })}
      />
      <TextField
        label="Tulisan tombol kirim"
        value={el.submitLabel}
        onCommit={(submitLabel) => submitLabel.trim() && update('tombol kirim', { submitLabel })}
      />
      <NumberField
        label="Jarak tombol"
        value={el.gap}
        min={0}
        onCommit={(gap) => update('jarak tombol', { gap })}
      />
      <TextStyleFields
        value={el.textStyle}
        onChange={(textStyle) => update('teks kolom', { textStyle })}
      />
      <BoxStyleFields
        fillLabel="Kolom"
        value={el.fieldStyle}
        onChange={(fieldStyle) => update('gaya kolom', { fieldStyle })}
      />
      <TextStyleFields
        value={el.keyTextStyle}
        onChange={(keyTextStyle) => update('teks tombol', { keyTextStyle })}
      />
      <BoxStyleFields
        fillLabel="Tombol"
        value={el.keyStyle}
        onChange={(keyStyle) => update('gaya tombol', { keyStyle })}
      />
      <BoxStyleFields
        fillLabel="Tombol kirim"
        value={el.submitStyle}
        onChange={(submitStyle) => update('gaya tombol kirim', { submitStyle })}
      />
    </Section>
  );
}

function ConsentProps({ el, update }: { el: ElementOf<'consent-checkbox'>; update: Update }) {
  return (
    <Section title="Persetujuan">
      <TextField
        label="Pernyataan"
        multiline
        value={el.label}
        testId="prop-consent-label"
        onCommit={(label) => label.trim() && update('pernyataan', { label: label.trim() })}
      />
      <Toggle
        label="Wajib dicentang"
        value={el.required}
        testId="prop-consent-required"
        onCommit={(required) => update('wajib', { required })}
      />
      <p className="text-xs text-muted-foreground">
        Wajib: tombol lanjut di halaman ini mati sampai pembeli mencentang. Teks pernyataan disimpan
        bersama sesi.
      </p>
      <NumberField
        label="Ukuran kotak"
        value={el.boxSize}
        min={8}
        max={400}
        onCommit={(boxSize) => update('ukuran kotak', { boxSize })}
      />
      <ColorField
        label="Warna centang"
        value={el.checkColor}
        onCommit={(checkColor) => update('warna centang', { checkColor })}
      />
      <TextStyleFields
        value={el.textStyle}
        onChange={(textStyle) => update('teks', { textStyle })}
      />
      <BoxStyleFields
        fillLabel="Kotak"
        value={el.boxStyle}
        onChange={(boxStyle) => update('kotak', { boxStyle })}
      />
      <BoxStyleFields
        fillLabel="Kotak dicentang"
        value={el.checkedStyle}
        onChange={(checkedStyle) => update('kotak dicentang', { checkedStyle })}
      />
    </Section>
  );
}

const MAX_SURVEY_OPTIONS = 12;

function SurveyProps({ el, update }: { el: ElementOf<'survey-question'>; update: Update }) {
  const setOptions = (options: ElementOf<'survey-question'>['options']) =>
    update('pilihan jawaban', { options });
  return (
    <Section title="Pertanyaan survei">
      <TextField
        label="Pertanyaan"
        value={el.question}
        testId="prop-survey-question"
        onCommit={(question) => update('pertanyaan', { question })}
      />
      <Toggle
        label="Wajib dijawab"
        value={el.required}
        testId="prop-survey-required"
        onCommit={(required) => update('wajib', { required })}
      />
      <Toggle
        label="Boleh pilih lebih dari satu"
        value={el.multiple}
        onCommit={(multiple) => update('pilihan ganda', { multiple })}
      />
      <div className="space-y-1" data-testid="prop-survey-options">
        {el.options.map((o, i) => (
          <div key={o.id} className="flex items-end gap-1">
            <div className="flex-1">
              <TextField
                label={`Pilihan ${i + 1}`}
                value={o.label}
                onCommit={(label) =>
                  label.trim() &&
                  setOptions(
                    el.options.map((x) => (x.id === o.id ? { ...x, label: label.trim() } : x)),
                  )
                }
              />
            </div>
            <IconButton
              title={`Hapus pilihan ${i + 1}`}
              disabled={el.options.length <= 1}
              onClick={() => setOptions(el.options.filter((x) => x.id !== o.id))}
            >
              ✕
            </IconButton>
          </div>
        ))}
        <button
          type="button"
          className="text-xs text-primary hover:underline disabled:opacity-40"
          disabled={el.options.length >= MAX_SURVEY_OPTIONS}
          data-testid="prop-survey-add-option"
          onClick={() =>
            setOptions([
              ...el.options,
              { id: createId(), label: `Pilihan ${el.options.length + 1}` },
            ])
          }
        >
          + Tambah pilihan
        </button>
      </div>
      <SelectField
        label="Susunan"
        value={el.layout}
        options={[
          { value: 'row', label: 'Satu baris' },
          { value: 'grid', label: 'Grid' },
          { value: 'column', label: 'Satu kolom' },
        ]}
        onCommit={(layout) => update('susunan', { layout })}
      />
      {el.layout === 'grid' && (
        <NumberField
          label="Kolom"
          value={el.columns}
          min={1}
          max={6}
          onCommit={(columns) => update('kolom', { columns })}
        />
      )}
      <NumberField
        label="Jarak"
        value={el.gap}
        min={0}
        onCommit={(gap) => update('jarak', { gap })}
      />
      <Toggle
        label="Tampilkan teks pertanyaan"
        value={!!el.questionStyle}
        onCommit={(on) =>
          update('teks pertanyaan', {
            questionStyle: on ? { ...el.optionTextStyle, fontWeight: 700 } : undefined,
          })
        }
      />
      {el.questionStyle && (
        <TextStyleFields
          value={el.questionStyle}
          onChange={(questionStyle) => update('gaya pertanyaan', { questionStyle })}
        />
      )}
      <TextStyleFields
        value={el.optionTextStyle}
        onChange={(optionTextStyle) => update('teks pilihan', { optionTextStyle })}
      />
      <BoxStyleFields
        fillLabel="Pilihan"
        value={el.optionStyle}
        onChange={(optionStyle) => update('gaya pilihan', { optionStyle })}
      />
      <BoxStyleFields
        fillLabel="Pilihan terpilih"
        value={el.selectedStyle}
        onChange={(selectedStyle) => update('gaya terpilih', { selectedStyle })}
      />
    </Section>
  );
}

function pickText(el: ElementOf<'text'> | ElementOf<'price-label'>) {
  const { fontFamily, fontSize, fontWeight, color, align: a, lineHeight, letterSpacing } = el;
  return { fontFamily, fontSize, fontWeight, color, align: a, lineHeight, letterSpacing };
}

/** Uploaded fonts are referenced by family name; register the asset in the config too. */
function ensureFont(fontAssetId: string | undefined, assets: AssetItem[]) {
  return (d: Draft<BoothConfig>) => {
    const a = fontAssetId ? assets.find((x) => x.id === fontAssetId) : undefined;
    if (a) ensureAssetRef(d, a);
  };
}

function TextProps({ el, update }: { el: ElementOf<'text'>; update: Update }) {
  const fonts = useFontAssets();
  return (
    <Section title="Teks">
      <TextField
        label="Isi"
        multiline
        testId="prop-content"
        value={el.content}
        onCommit={(content) => update('isi', { content })}
      />
      <p className="text-[10px] text-muted-foreground">
        Token: {'{{price}} {{boothName}} {{date}} {{paymentHint}}'}
      </p>
      <TextStyleFields
        value={pickText(el)}
        onChange={(ts, fontId) => update('teks', ts, ensureFont(fontId, fonts))}
      />
    </Section>
  );
}

function useFontAssets() {
  return useEnv().assets;
}

const ACTIONS: { value: ButtonAction['kind']; label: string }[] = [
  { value: 'start', label: 'Mulai' },
  { value: 'next', label: 'Lanjut' },
  { value: 'back', label: 'Kembali' },
  { value: 'confirm', label: 'Konfirmasi' },
  { value: 'finish', label: 'Selesai' },
  { value: 'retake', label: 'Ulang foto' },
  { value: 'retakeAll', label: 'Ulang semua' },
  { value: 'selectFilter', label: 'Pilih filter' },
  { value: 'addPrint', label: 'Tambah cetak' },
  { value: 'removePrint', label: 'Kurangi cetak' },
  { value: 'selectPayment', label: 'Pilih pembayaran' },
];

function ButtonProps({ el, update }: { el: ElementOf<'button'>; update: Update }) {
  const filters = useEditor((s) => s.doc.filters);
  const methods = useEditor((s) => s.doc.flow.paymentMethods);
  const setAction = (kind: ButtonAction['kind']) => {
    const action: ButtonAction =
      kind === 'selectFilter'
        ? { kind, filterId: filters[0]?.id ?? '' }
        : kind === 'selectPayment'
          ? { kind, method: methods[0] ?? 'qris' }
          : kind === 'retake'
            ? { kind }
            : ({ kind } as ButtonAction);
    update('aksi', { action });
  };
  const a = el.action;
  return (
    <Section title="Tombol">
      <TextField
        label="Label"
        value={el.label ?? ''}
        onCommit={(label) => update('label', { label: label || undefined })}
      />
      <SelectField
        label="Aksi"
        testId="prop-action"
        value={a.kind}
        options={ACTIONS}
        onCommit={setAction}
      />
      {a.kind === 'selectFilter' && (
        <SelectField
          label="Filter"
          value={a.filterId}
          options={filters.map((f) => ({ value: f.id, label: f.name }))}
          onCommit={(filterId) => update('aksi', { action: { kind: 'selectFilter', filterId } })}
        />
      )}
      {a.kind === 'selectPayment' && (
        <SelectField
          label="Metode"
          value={a.method}
          options={[
            { value: 'qris', label: 'QRIS' },
            { value: 'voucher', label: 'Voucher' },
            { value: 'cash', label: 'Tunai' },
          ]}
          onCommit={(method) => update('aksi', { action: { kind: 'selectPayment', method } })}
        />
      )}
      {a.kind === 'retake' && (
        <NumberField
          label="Foto ke-"
          value={a.shotIndex}
          min={1}
          onCommit={(shotIndex) =>
            update('aksi', { action: { kind: 'retake', shotIndex: Math.round(shotIndex) } })
          }
        />
      )}
      <AssetField
        label="Gambar"
        kind="image"
        allowEmpty
        value={el.assetId}
        onPick={(asset) =>
          update('gambar', { assetId: asset?.id }, (d) => asset && ensureAssetRef(d, asset))
        }
      />
      {el.textStyle && (
        <TextStyleFields
          value={el.textStyle}
          onChange={(textStyle) => update('teks', { textStyle })}
        />
      )}
      <h4 className="pt-1 text-[11px] text-muted-foreground">Saat ditekan</h4>
      <BoxStyleFields
        value={el.pressedStyle}
        onChange={(pressedStyle) => update('ditekan', { pressedStyle })}
      />
    </Section>
  );
}

function PhotoSlotProps({ el, update }: { el: ElementOf<'photo-slot'>; update: Update }) {
  const e = el.emptyStyle;
  return (
    <Section title="Slot foto">
      <NumberField
        label="Slot ke-"
        testId="prop-slot-index"
        value={el.slotIndex}
        min={1}
        onCommit={(slotIndex) => update('slot', { slotIndex: Math.round(slotIndex) })}
      />
      <Toggle
        label="Tombol ulang"
        value={el.showRetakeButton}
        onCommit={(showRetakeButton) => update('ulang', { showRetakeButton })}
      />
      <h4 className="pt-1 text-[11px] text-muted-foreground">Kosong</h4>
      <BoxStyleFields
        value={{
          fill: e.fill,
          borderColor: e.borderColor,
          borderWidth: e.borderWidth,
          borderRadius: e.borderRadius,
          shadow: e.shadow,
        }}
        onChange={(box) => update('kosong', { emptyStyle: { ...stripBox(e), ...box } })}
      />
      <Toggle
        label="Angka"
        value={e.showNumber}
        onCommit={(showNumber) => update('angka', { emptyStyle: { ...e, showNumber } })}
      />
      <ColorField
        label="Warna angka"
        value={e.numberColor}
        onCommit={(numberColor) =>
          numberColor && update('angka', { emptyStyle: { ...e, numberColor } })
        }
      />
      <h4 className="pt-1 text-[11px] text-muted-foreground">Terisi</h4>
      <BoxStyleFields
        value={el.filledStyle}
        onChange={(filledStyle) => update('terisi', { filledStyle: filledStyle ?? {} })}
      />
      <h4 className="pt-1 text-[11px] text-muted-foreground">Aktif</h4>
      <BoxStyleFields
        value={el.activeStyle}
        onChange={(activeStyle) => update('aktif', { activeStyle: activeStyle ?? {} })}
      />
    </Section>
  );
}

function stripBox<T extends object>(s: T) {
  const {
    fill: _f,
    borderColor: _bc,
    borderWidth: _bw,
    borderRadius: _br,
    shadow: _s,
    ...rest
  } = s as T & Record<string, unknown>;
  return rest;
}

// --- Page ------------------------------------------------------------------------------------

const TRANSITIONS = [
  { value: 'none', label: 'Tidak ada' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide-left', label: 'Geser kiri' },
  { value: 'slide-up', label: 'Geser naik' },
  { value: 'zoom', label: 'Zoom' },
] as const;

export function BackgroundFields({
  value,
  onChange,
  allowNone,
}: {
  value: Background | undefined;
  onChange: (bg: Background | undefined, asset?: AssetItem) => void;
  allowNone?: boolean;
}) {
  const kind = value?.kind ?? 'none';
  const options = [
    ...(allowNone ? [{ value: 'none', label: 'Ikuti halaman' }] : []),
    { value: 'color', label: 'Warna' },
    { value: 'gradient', label: 'Gradien' },
    { value: 'image', label: 'Gambar' },
    { value: 'video', label: 'Video' },
  ] as const;
  return (
    <>
      <SelectField
        label="Latar"
        testId="bg-kind"
        value={kind}
        options={options}
        onCommit={(k) => {
          if (k === 'none') onChange(undefined);
          else if (k === 'color') onChange({ kind: 'color', color: '#0f172a' });
          else if (k === 'gradient')
            onChange({
              kind: 'gradient',
              css: 'linear-gradient(135deg, #1e1b4b 0%, #831843 100%)',
            });
          else if (k === 'image') onChange({ kind: 'image', assetId: '', fit: 'cover' });
          else onChange({ kind: 'video', assetId: '', loop: true, muted: true });
        }}
      />
      {value?.kind === 'color' && (
        <ColorField
          label="Warna"
          testId="bg-color"
          value={value.color}
          onCommit={(color) => color && onChange({ kind: 'color', color })}
        />
      )}
      {value?.kind === 'gradient' && (
        <TextField
          label="CSS"
          multiline
          value={value.css}
          onCommit={(css) => onChange({ kind: 'gradient', css })}
        />
      )}
      {value?.kind === 'image' && (
        <>
          <AssetField
            label="Gambar"
            kind="image"
            value={value.assetId || undefined}
            onPick={(a) => a && onChange({ ...value, assetId: a.id }, a)}
          />
          <SelectField
            label="Fit"
            value={value.fit}
            options={[
              { value: 'cover', label: 'Cover' },
              { value: 'contain', label: 'Contain' },
            ]}
            onCommit={(fit) => onChange({ ...value, fit })}
          />
        </>
      )}
      {value?.kind === 'video' && (
        <AssetField
          label="Video"
          kind="video"
          value={value.assetId || undefined}
          onPick={(a) => a && onChange({ ...value, assetId: a.id }, a)}
        />
      )}
    </>
  );
}

const PAGE_TOGGLE: Partial<Record<PageType, 'tutorialEnabled' | 'reviewEnabled'>> = {
  tutorial: 'tutorialEnabled',
  review: 'reviewEnabled',
};

function PageProps({ page }: { page: PageType }) {
  const apply = useApply();
  const p = useEditor((s) => s.doc.pages[page]);
  const flow = useEditor((s) => s.doc.flow);
  const toggle = PAGE_TOGGLE[page];
  const transition: Transition = p.transitionIn ?? { kind: 'none', durationMs: 0 };
  return (
    <div data-testid="page-props">
      <Section title={`Halaman ${PAGE_LABEL[page]}`}>
        {toggle && (
          <Toggle
            label="Halaman aktif"
            value={flow[toggle]}
            onCommit={(v) => apply('Aktifkan halaman', (d) => void (d.flow[toggle] = v))}
          />
        )}
        {page === 'payment' && (
          <Toggle
            label="Mode event (gratis)"
            value={flow.eventMode}
            onCommit={(v) => apply('Mode event', (d) => void (d.flow.eventMode = v))}
          />
        )}
        <BackgroundFields
          value={p.background}
          onChange={(bg, asset) => {
            if (bg) {
              apply('Ubah latar', (d) => {
                d.pages[page].background = bg;
                if (asset) ensureAssetRef(d, asset);
              });
            }
          }}
        />
      </Section>
      <Section title="Transisi masuk">
        <SelectField
          label="Efek"
          value={transition.kind}
          options={TRANSITIONS}
          onCommit={(kind) =>
            apply(
              'Transisi',
              (d) =>
                void (d.pages[page].transitionIn = {
                  kind,
                  durationMs: transition.durationMs || 250,
                }),
            )
          }
        />
        <NumberField
          label="Durasi (ms)"
          value={transition.durationMs}
          min={0}
          max={2000}
          step={50}
          onCommit={(durationMs) =>
            apply(
              'Transisi',
              (d) => void (d.pages[page].transitionIn = { kind: transition.kind, durationMs }),
            )
          }
        />
      </Section>
      {page !== 'cover' && page !== 'processing' && page !== 'result' && (
        <Section title="Idle">
          <NumberField
            label="Timeout (dtk)"
            value={flow.idleTimeoutSec[page]}
            min={0}
            onCommit={(sec) =>
              apply('Idle timeout', (d) => {
                if (sec > 0) d.flow.idleTimeoutSec[page] = Math.round(sec);
                else delete d.flow.idleTimeoutSec[page];
              })
            }
          />
          <p className="text-[10px] text-muted-foreground">
            0 = tanpa batas. Sebelum bayar, idle kembali ke Cover.
          </p>
        </Section>
      )}
      {page === 'result' && (
        <Section title="Kembali otomatis">
          <NumberField
            label="Setelah (dtk)"
            value={flow.resultAutoReturnSec}
            min={1}
            onCommit={(v) =>
              apply('Auto kembali', (d) => void (d.flow.resultAutoReturnSec = Math.round(v)))
            }
          />
        </Section>
      )}
    </div>
  );
}

// --- Frame & slot ----------------------------------------------------------------------------

function FrameProps() {
  const apply = useApply();
  const ctx = useCtx();
  const doc = useEditor((s) => s.doc);
  const frame = frameOf(doc, ctx);
  if (!frame) return null;
  const fid = frame.id;
  const setFrame = (
    label: string,
    fn: (f: Draft<BoothConfig>['frames'][number], d: Draft<BoothConfig>) => void,
  ) =>
    apply(label, (d) => {
      const f = d.frames.find((x) => x.id === fid);
      if (f) fn(f, d);
    });
  return (
    <div data-testid="frame-props">
      <Section title="Frame">
        <TextField
          label="Nama"
          value={frame.name}
          onCommit={(name) => setFrame('Nama frame', (f) => void (f.name = name || f.name))}
        />
        <Toggle
          label="Aktif"
          value={frame.enabled}
          onCommit={(enabled) => setFrame('Aktif frame', (f) => void (f.enabled = enabled))}
        />
        <NumberField
          label="Harga (Rp)"
          value={frame.price}
          min={0}
          step={1000}
          onCommit={(price) => setFrame('Harga frame', (f) => void (f.price = Math.round(price)))}
        />
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => setFrame('Harga frame', (f) => void delete f.price)}
        >
          Pakai harga dasar booth
        </button>
      </Section>
      <Section title="Gambar frame">
        <AssetField
          label="Overlay"
          kind="image"
          value={frame.overlayAssetId}
          onPick={(a) =>
            a &&
            setFrame('Overlay', (f, d) => {
              f.overlayAssetId = a.id;
              // The picker draws the frame design itself; keep the legacy field in step.
              f.thumbnailAssetId = a.id;
              ensureAssetRef(d, a);
            })
          }
        />
        <AssetField
          label="Underlay"
          kind="image"
          allowEmpty
          value={frame.underlayAssetId}
          onPick={(a) =>
            setFrame('Underlay', (f, d) => {
              if (a) {
                f.underlayAssetId = a.id;
                ensureAssetRef(d, a);
              } else delete f.underlayAssetId;
            })
          }
        />
        <p className="text-[10px] text-muted-foreground">
          Overlay: PNG transparan {doc.printProfile.stripPx.width}×{doc.printProfile.stripPx.height}{' '}
          px.
        </p>
      </Section>
    </div>
  );
}

function SlotProps({ index }: { index: number }) {
  const apply = useApply();
  const ctx = useCtx();
  const doc = useEditor((s) => s.doc);
  const slot = frameOf(doc, ctx)?.slots.find((s) => s.index === index);
  if (!slot) return null;
  const set = (label: string, patch: Partial<typeof slot>) =>
    apply(label, (d, c) => updateSlot(d, c, index, patch), {
      coalesceKey: `slot:${index}:${label}`,
    });
  return (
    <div data-testid="slot-props">
      <Section title={`Slot foto ${index}`}>
        <Grid2>
          <NumberField
            compact
            label="X"
            hint="Posisi X (px artboard)"
            value={slot.x}
            onCommit={(x) => set('X', { x })}
          />
          <NumberField
            compact
            label="Y"
            hint="Posisi Y (px artboard)"
            value={slot.y}
            onCommit={(y) => set('Y', { y })}
          />
          <NumberField
            compact
            label="Lebar"
            hint="Lebar (px artboard)"
            value={slot.width}
            min={1}
            onCommit={(width) => set('W', { width })}
          />
          <NumberField
            compact
            label="Tinggi"
            hint="Tinggi (px artboard)"
            value={slot.height}
            min={1}
            onCommit={(height) => set('H', { height })}
          />
        </Grid2>
        <Grid2>
          <NumberField
            compact
            label="Rotasi"
            hint="Rotasi (derajat)"
            value={slot.rotation}
            onCommit={(rotation) => set('Rotasi', { rotation })}
          />
          <NumberField
            compact
            label="Sudut"
            hint="Radius sudut (px)"
            value={slot.borderRadius}
            min={0}
            onCommit={(borderRadius) => set('Radius', { borderRadius })}
          />
        </Grid2>
        <Row label="Rasio">
          <span className="text-xs">{(slot.width / slot.height).toFixed(2)} : 1</span>
        </Row>
      </Section>
    </div>
  );
}
