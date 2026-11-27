'use client';

import type { ElementOf } from '@pb/schema';
import { useRenderer } from '../context';
import { boxStyleToCss, textStyleToCss } from '../styles';

const fill = { position: 'absolute', inset: 0 } as const;

/**
 * Tick box + statement. Editor: drawn unticked. Live: a tap anywhere on the element toggles it
 * (big touch target for a kiosk).
 */
export function ConsentCheckboxElementView({ el }: { el: ElementOf<'consent-checkbox'> }) {
  const { mode, runtime, onAction } = useRenderer();
  const checked = mode === 'live' && (runtime.checkedConsents ?? []).includes(el.id);
  const live = mode === 'live';
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      data-pb-consent={el.id}
      data-pb-checked={checked ? 'true' : 'false'}
      onClick={live ? () => onAction({ kind: 'toggleConsent', elementId: el.id }) : undefined}
      tabIndex={live ? 0 : -1}
      style={{
        ...fill,
        display: 'flex',
        alignItems: 'center',
        gap: Math.max(8, el.boxSize * 0.4),
        padding: 0,
        border: 'none',
        background: 'transparent',
        textAlign: 'left',
        cursor: live ? 'pointer' : 'default',
        ...boxStyleToCss(el.style),
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'relative',
          flex: 'none',
          width: el.boxSize,
          height: el.boxSize,
          boxSizing: 'border-box',
          ...boxStyleToCss(checked ? { ...el.boxStyle, ...el.checkedStyle } : el.boxStyle),
        }}
      >
        {checked && (
          <svg viewBox="0 0 24 24" style={{ ...fill, width: '100%', height: '100%' }}>
            <path
              d="M5 12.5l4.5 4.5L19 7.5"
              fill="none"
              stroke={el.checkColor}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span style={{ ...textStyleToCss(el.textStyle), flex: 1, minWidth: 0 }}>
        {el.label}
        {el.required && <span aria-hidden> *</span>}
      </span>
    </button>
  );
}

/** Question line + option buttons. Editor: the first option is drawn picked, as a sample. */
export function SurveyQuestionElementView({ el }: { el: ElementOf<'survey-question'> }) {
  const { mode, runtime, onAction } = useRenderer();
  const live = mode === 'live';
  const picked = live ? (runtime.surveyAnswers?.[el.id] ?? []) : [el.options[0]?.id];
  const q = el.questionStyle;
  const questionHeight = q && el.question ? q.fontSize * q.lineHeight * 1.6 : 0;
  const columns = el.layout === 'row' ? el.options.length : el.layout === 'column' ? 1 : el.columns;
  return (
    <div
      role="group"
      aria-label={el.question || el.name}
      data-pb-survey={el.id}
      style={{ ...fill, display: 'flex', flexDirection: 'column', ...boxStyleToCss(el.style) }}
    >
      {questionHeight > 0 && (
        <div style={{ ...textStyleToCss(q), flex: 'none', height: questionHeight }}>
          {el.question}
          {el.required && <span aria-hidden> *</span>}
        </div>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridAutoRows: '1fr',
          gap: el.gap,
        }}
      >
        {el.options.map((o) => {
          const selected = picked.includes(o.id);
          return (
            <button
              key={o.id}
              type="button"
              role={el.multiple ? 'checkbox' : 'radio'}
              aria-checked={selected}
              data-pb-option={o.id}
              data-pb-selected={selected ? 'true' : 'false'}
              onClick={
                live
                  ? () => onAction({ kind: 'selectOption', elementId: el.id, optionId: o.id })
                  : undefined
              }
              tabIndex={live ? 0 : -1}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 8,
                minWidth: 0,
                overflow: 'hidden',
                border: 'none',
                background: 'transparent',
                cursor: live ? 'pointer' : 'default',
                ...boxStyleToCss(
                  selected ? { ...el.optionStyle, ...el.selectedStyle } : el.optionStyle,
                ),
              }}
            >
              <span style={{ ...textStyleToCss(el.optionTextStyle), width: '100%' }}>
                {o.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
