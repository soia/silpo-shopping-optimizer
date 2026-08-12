/**
 * Semantic layer.
 *
 * The model has exactly one job: decide whether a replacement preserves what
 * the customer meant to buy. It never sees or invents a price — every number is
 * recomputed by the deterministic code below.
 *
 * Without an API key a rule-based fallback takes over, so the bot stays usable.
 */

import type { AIDecision, OptimizationPlan, Replacement } from './types.ts';

const MODEL = 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

export const SYSTEM_PROMPT = `Ти — асистент, який перевіряє заміни товарів у кошику супермаркету «Сільпо».

ТВОЯ ЄДИНА ЗАДАЧА: вирішити, чи зберігає запропонована заміна СУТЬ покупки.

ПРИЙМАЙ заміну, якщо товар виконує ту саму роль:
- молоко 2.5% → інше молоко 2.5%
- макарони → макарони іншого бренду
- куряче філе → куряче філе
- пральний порошок → пральний порошок

ВІДХИЛЯЙ заміну, якщо змінюється призначення товару:
- протеїновий/спортивний продукт → звичайний солодкий (інша мета покупки)
- молоко → рослинний напій (і навпаки)
- комбуча/ферментований напій → звичайний сік або газованка
- безлактозний/безглютеновий → звичайний (дієтичне обмеження!)
- дитяче харчування → недитяче
- товар без цукру → товар із цукром
- кардинально інший смак, якщо смак є суттю покупки

ОСОБЛИВА УВАГА — розмір упаковки:
Дані «Сільпо» НЕ містять об'єму/ваги кандидатів. Якщо ціна падає більш ніж
на 50%, це може означати меншу упаковку, а не вигіднішу пропозицію.
У таких випадках став confidence не вище 0.6 і напиши в reason,
що варто перевірити об'єм.

ФОРМАТ ВІДПОВІДІ — виключно JSON, без markdown і пояснень:
{"decisions":[{"index":0,"accept":true,"confidence":0.85,"reason":"Той самий батончик Snickers, менша версія без Super+1"}]}

reason — українською, до 90 символів, конкретно про товар.
confidence — 0.0..1.0, наскільки впевнений, що суть покупки збережена.`;

/** Compact payload: only what a semantic decision actually needs. */
export function buildUserPrompt(replacements: Replacement[]): string {
  const lines = replacements.map((r, i) =>
    [
      `[${i}]`,
      `було: ${r.originalName}${r.originalRatio ? ` (${r.originalRatio})` : ''}`,
      `стане: ${r.replacementName}`,
      `падіння ціни: ${r.savingPct}%${r.verifySize ? ' ⚠️ підозріло велике' : ''}`,
      r.onPromotion ? 'кандидат за акцією' : null,
    ]
      .filter(Boolean)
      .join(' | '),
  );

  return `Перевір ці ${replacements.length} замін. Для кожної вирішиш, чи збережена суть покупки.\n\n${lines.join('\n')}`;
}

/**
 * Rule-based fallback. Deliberately conservative: rejecting a valid swap costs
 * the customer nothing, while accepting a wrong one puts the wrong food in
 * their basket.
 */
export function fallbackDecisions(replacements: Replacement[]): AIDecision[] {
  const redFlags: Array<[RegExp, string]> = [
    [/протеїн|protein|nutri|profeel/i, 'оригінал — протеїновий продукт'],
    [/безлактозн/i, 'оригінал — безлактозний'],
    [/без цукру|безглютен|без глютен/i, 'оригінал має дієтичне обмеження'],
    [/комбуч/i, 'оригінал — ферментований напій'],
    [/дитяч|milupa/i, 'оригінал — дитяче харчування'],
  ];

  return replacements.map((r, index) => {
    let blocker: string | null = null;
    for (const [pattern, label] of redFlags) {
      if (pattern.test(r.originalName) && !pattern.test(r.replacementName)) {
        blocker = label;
        break;
      }
    }

    const accept = !blocker && r.finalScore >= 0.6 && !r.verifySize;
    return {
      index,
      accept,
      confidence: accept ? Math.min(0.75, r.finalScore) : 0.3,
      reason: accept
        ? `Схожий товар тієї ж категорії${r.onPromotion ? ', за акцією' : ''}`
        : blocker ?? (r.verifySize ? 'Підозріло велике падіння ціни — можлива менша упаковка' : 'Недостатня схожість'),
      source: 'fallback',
    };
  });
}

export interface RankResult {
  decisions: AIDecision[];
  usedAI: boolean;
  reason?: string;
  usage?: unknown;
}

/** Runs the semantic check. Any failure degrades silently to the fallback. */
export async function rankWithAI(replacements: Replacement[], apiKey = process.env.ANTHROPIC_API_KEY): Promise<RankResult> {
  if (!apiKey) return { decisions: fallbackDecisions(replacements), usedAI: false, reason: 'ANTHROPIC_API_KEY is not set' };
  if (!replacements.length) return { decisions: [], usedAI: false, reason: 'nothing to rank' };

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(replacements) }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: unknown };
    const text = body.content?.find((c) => c.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) as { decisions?: AIDecision[] };

    const byIndex = new Map((parsed.decisions ?? []).map((d) => [d.index, d]));
    const decisions: AIDecision[] = replacements.map((r, i) => {
      const decision = byIndex.get(i);
      if (!decision) return { ...fallbackDecisions([r])[0], index: i };
      return {
        index: i,
        accept: Boolean(decision.accept),
        confidence: Math.max(0, Math.min(1, Number(decision.confidence) || 0)),
        reason: String(decision.reason ?? '').slice(0, 120),
        source: 'ai',
      };
    });
    return { decisions, usedAI: true, usage: body.usage };
  } catch (e) {
    return { decisions: fallbackDecisions(replacements), usedAI: false, reason: `AI unavailable: ${(e as Error).message}` };
  }
}

/** Applies the decisions and recomputes every total deterministically. */
export function applyDecisions(plan: OptimizationPlan, decisions: AIDecision[], minConfidence = 0.5): OptimizationPlan {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const kept: Replacement[] = [];
  const dropped: Replacement[] = [];

  plan.replacements.forEach((r, i) => {
    const decision = decisions[i];
    const enriched: Replacement = {
      ...r,
      aiReason: decision?.reason ?? null,
      aiConfidence: decision?.confidence ?? null,
      aiSource: decision?.source ?? null,
    };
    (decision?.accept && decision.confidence >= minConfidence ? kept : dropped).push(enriched);
  });

  const saving = round2(kept.reduce((sum, r) => sum + r.saving, 0));
  const { originalTotal } = plan.summary;

  return {
    replacements: kept,
    rejectedByAI: dropped,
    summary: {
      ...plan.summary,
      replacementsFound: kept.length,
      promotionsUsed: kept.filter((r) => r.onPromotion).length,
      optimizedTotal: round2(originalTotal - saving),
      saving,
      savingPct: originalTotal > 0 ? round2((saving / originalTotal) * 100) : 0,
    },
  };
}
