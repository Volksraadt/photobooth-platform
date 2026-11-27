import { expect, test } from '@playwright/test';
import type { BoothConfig, Element } from '@pb/schema';
import { flowValue, goToCapture, onPage, openKiosk, tap } from './helpers';

const TEXT = {
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: 28,
  fontWeight: 400,
  color: '#ffffff',
  align: 'left' as const,
  lineHeight: 1.3,
  letterSpacing: 0,
};
const BASE = { rotation: 0, opacity: 1, visible: true, locked: false };

const consent: Element = {
  ...BASE,
  id: 'f8-consent',
  name: 'Persetujuan',
  type: 'consent-checkbox',
  x: 460,
  y: 900,
  width: 1000,
  height: 80,
  label: 'Saya setuju foto saya disimpan',
  required: true,
  textStyle: TEXT,
  boxSize: 44,
  boxStyle: { fill: '#ffffff', borderColor: '#cbd5e1', borderWidth: 3, borderRadius: 10 },
  checkedStyle: { fill: '#ec4899' },
  checkColor: '#ffffff',
};

const question: Element = {
  ...BASE,
  id: 'f8-question',
  name: 'Pertanyaan',
  type: 'survey-question',
  x: 1300,
  y: 80,
  width: 560,
  height: 300,
  question: 'Tahu booth ini dari mana?',
  options: [
    { id: 'ig', label: 'Instagram' },
    { id: 'fr', label: 'Teman' },
  ],
  multiple: false,
  required: true,
  layout: 'column',
  columns: 1,
  gap: 12,
  questionStyle: TEXT,
  optionTextStyle: { ...TEXT, align: 'center' },
  optionStyle: { fill: '#1e293b', borderRadius: 16 },
  selectedStyle: { fill: '#ec4899', borderRadius: 16 },
};

test('F8: required consent gates Start; survey answer gates Review; answers are stored', async ({
  page,
}) => {
  await page.route('**/booth-config.json', async (route) => {
    const res = await route.fetch();
    const config = (await res.json()) as BoothConfig;
    config.pages.cover.elements.push(consent);
    config.pages.review.elements.push(question);
    await route.fulfill({ response: res, json: config });
  });
  await openKiosk(page);

  const start = page.locator('.pb-root [data-pb-action="start"]').first();
  await expect(start).toHaveAttribute('aria-disabled', 'true');
  await start.click({ force: true });
  await expect(onPage(page, 'cover')).toBeVisible();

  const box = page.locator('[data-pb-consent="f8-consent"]');
  await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await expect(start).not.toHaveAttribute('aria-disabled', 'true');

  await goToCapture(page);
  await expect.poll(() => flowValue(page), { timeout: 30_000 }).toEqual({ capture: 'waiting' });
  await tap(page, 'next');
  await expect(onPage(page, 'review')).toBeVisible();

  const confirm = page.locator('.pb-root [data-pb-action="confirm"]').first();
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await page.locator('[data-pb-survey="f8-question"] [data-pb-option="fr"]').click();
  await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
  await confirm.click();
  await expect(onPage(page, 'result')).toBeVisible({ timeout: 10_000 });

  const stored = await page.evaluate(
    () =>
      new Promise<{ responses?: { kind: string; elementId: string; optionLabels?: string[] }[] }[]>(
        (resolve, reject) => {
          const req = indexedDB.open('pb-kiosk');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const all = req.result.transaction('sessions').objectStore('sessions').getAll();
            all.onsuccess = () => resolve(all.result);
            all.onerror = () => reject(all.error);
          };
        },
      ),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]!.responses).toEqual([
    expect.objectContaining({ kind: 'consent', elementId: 'f8-consent' }),
    expect.objectContaining({ kind: 'survey', elementId: 'f8-question', optionLabels: ['Teman'] }),
  ]);

  // The next buyer starts unticked.
  await tap(page, 'finish');
  await expect(onPage(page, 'cover')).toBeVisible();
  await expect(box).toHaveAttribute('aria-checked', 'false');
});
