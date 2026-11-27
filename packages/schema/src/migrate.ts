import { CURRENT_SCHEMA_VERSION } from './booth-config';
import { validateBoothConfig, type ValidationIssue, type ValidationResult } from './validate';

type Migration = (config: Record<string, unknown>) => Record<string, unknown>;

/**
 * MIGRATIONS[n] upgrades a config from schemaVersion n to n+1.
 * Add an entry here whenever BoothConfig changes shape, then bump CURRENT_SCHEMA_VERSION.
 */
const MIGRATIONS: Record<number, Migration> = {
  1: splitVoucherFieldKeypad,
  2: addResponseElements,
  3: addContactInput,
};

/** v3 → v4 (F9): adds the `contact-input` element type. No content change (see v2 → v3). */
function addContactInput(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config, schemaVersion: 4 };
}

/**
 * v2 → v3 (F8): adds the `consent-checkbox` and `survey-question` element types. Existing
 * configs need no change; the bump only stops an older kiosk from loading a design it cannot
 * draw (it refuses an unknown schemaVersion instead of failing on an unknown element).
 */
function addResponseElements(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config, schemaVersion: 3 };
}

type RawElement = Record<string, unknown> & {
  id: string;
  type: string;
  variant?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  textStyle: { fontSize: number } & Record<string, unknown>;
};

/** Gap between voucher keys (artboard px), as drawn by schema v1. */
const VOUCHER_KEY_GAP = 8;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * v1 → v2: a `voucher-input` of variant `field` drew its keypad inside its own box (below the
 * field, or beside it when the box is wide and short). v2 makes the keypad its own
 * `voucher-keypad` element so field and keypad can be placed and styled separately. The split
 * uses the exact v1 geometry, so the page looks the same after migrating.
 */
function splitVoucherFieldKeypad(config: Record<string, unknown>): Record<string, unknown> {
  const pages = (config.pages ?? {}) as Record<string, { elements?: RawElement[] }>;
  const nextPages: Record<string, unknown> = {};
  for (const [type, page] of Object.entries(pages)) {
    if (!page || !Array.isArray(page.elements)) {
      nextPages[type] = page;
      continue;
    }
    const elements: RawElement[] = [];
    for (const el of page.elements) {
      if (el.type !== 'voucher-input' || el.variant !== 'field') {
        elements.push(el);
        continue;
      }
      const g = VOUCHER_KEY_GAP;
      const { width: w, height: h } = el;
      const fieldHeight = Math.min(h, el.textStyle.fontSize * 2.4);
      const stackedRow = (h - fieldHeight - g - g * 3) / 4;
      const sideRow = (h - g * 3) / 4;
      const sideKeypadWidth = Math.min(sideRow * 2.4 * 3 + g * 2, w * 0.55);
      const side = sideRow > stackedRow * 1.15 && w - sideKeypadWidth - g >= fieldHeight * 3;
      const rowHeight = side ? sideRow : stackedRow;
      if (rowHeight < 20) {
        // v1 drew no keypad in this box: keyboard / barcode scanner only.
        elements.push(el);
        continue;
      }
      const keypadWidth = side ? sideKeypadWidth : Math.min(w, rowHeight * 2.4 * 3 + g * 2);
      const keypadHeight = rowHeight * 4 + g * 3;
      const keyFont = Math.min(el.textStyle.fontSize, rowHeight * 0.6);
      elements.push({
        ...el,
        width: r2(side ? w - keypadWidth - g : w),
        height: r2(fieldHeight),
      });
      const { variant: _variant, style: _style, ...base } = el;
      elements.push({
        ...base,
        id: `${el.id}-keypad`.slice(0, 64),
        type: 'voucher-keypad',
        name: 'Keypad voucher',
        x: r2(side ? el.x + w - keypadWidth : el.x),
        y: r2(side ? el.y : el.y + h - keypadHeight),
        width: r2(keypadWidth),
        height: r2(keypadHeight),
        textStyle: { ...el.textStyle, fontSize: r2(keyFont) },
        gap: g,
      });
    }
    nextPages[type] = { ...page, elements };
  }
  return { ...config, pages: nextPages, schemaVersion: 2 };
}

export type UpgradeResult =
  | { success: true; config: Record<string, unknown> }
  | { success: false; issues: ValidationIssue[] };

/**
 * Brings a stored config of any known schemaVersion to the current shape WITHOUT validating it.
 * Drafts may be semantically invalid while editing; they must still be upgraded, or every later
 * save/publish fails on the version check.
 */
export function upgradeBoothConfig(input: unknown): UpgradeResult {
  if (typeof input !== 'object' || input === null) {
    return {
      success: false,
      issues: [{ code: 'schema.not-object', path: '', message: 'Desain bukan objek config.' }],
    };
  }
  let config = input as Record<string, unknown>;
  let version = config.schemaVersion;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version > CURRENT_SCHEMA_VERSION
  ) {
    return {
      success: false,
      issues: [
        {
          code: 'schema.version-unsupported',
          path: 'schemaVersion',
          message: `schemaVersion ${String(version)} tidak didukung (versi terbaru ${CURRENT_SCHEMA_VERSION}).`,
        },
      ],
    };
  }
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      return {
        success: false,
        issues: [
          {
            code: 'schema.migration-missing',
            path: 'schemaVersion',
            message: `Tidak ada migrasi dari schemaVersion ${version}.`,
          },
        ],
      };
    }
    config = step(config);
    version += 1;
  }
  return { success: true, config };
}

/** Upgrade a stored config of any known schemaVersion to the current one, then validate. */
export function migrateBoothConfig(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) return validateBoothConfig(input);
  const upgraded = upgradeBoothConfig(input);
  if (!upgraded.success) return upgraded;
  return validateBoothConfig(upgraded.config);
}
