/**
 * Domain types, derived from real MCP responses (see `data/mcp-tools.json`
 * and `docs/mcp-reference.md`) — not from the written documentation.
 */

/** A line in the cart. Cart lines expose pack size as `ratio`. */
export interface CartItem {
  productId: string;
  companyId: string;
  branchId: string;
  slug: string;
  name: string;
  image?: string;
  ratio?: string | null;
  quantity: number;
  price: number;
  oldPrice?: number | null;
  subTotal: number;
  subDiscount: number;
  total: number;
  stock: number;
  weighted: boolean;
  addToBasketStep: number;
  comment?: string | null;
  available?: boolean;
  /** Search tools report pack size under this name; carried for shape reuse. */
  displayRatio?: string | null;
}

/**
 * A product as returned by search tools.
 *
 * Since silpo-mcp-service v1.108.0 these carry `displayRatio` — the pack size,
 * verified present on 19 of 19 candidates from `similar_products`. Before that
 * pack size was unavailable for candidates, which was the engine's main
 * quality ceiling.
 */
export interface ProductCandidate {
  id: string;
  name: string;
  slug: string;
  price: number;
  oldPrice?: number | null;
  stock: number;
  available: boolean;
  image?: string;
  weighted?: boolean;
  step?: number;
  companyId: string;
  branchId: string;
  externalProductId?: number;
  /** Pack size on search results, e.g. "180г", "1,5л". */
  displayRatio?: string | null;
  /** Present on cart lines only; kept optional so cart items reuse this shape. */
  ratio?: string | null;
  /** From `attributes["Торгова марка"]`, filled in when details are fetched. */
  brand?: string | null;
  /** Runners-up, used when the cart reveals the first choice is wrong. */
  alternates?: Alternate[];
}

export interface Alternate {
  productId: string;
  companyId: string;
  branchId: string;
  name: string;
  price: number;
  saving: number;
  brand: string | null;
}

export interface LoyaltyInfo {
  bonusAvailable: number;
  bonusTotal?: number;
  bonusRequested?: number | null;
  isEnabled?: boolean;
}

export interface Replacement {
  originalProductId: string;
  originalName: string;
  originalPrice: number;
  originalRatio: string | null;
  quantity: number;
  replacementProductId: string;
  replacementCompanyId: string;
  replacementBranchId: string;
  replacementName: string;
  replacementPrice: number;
  replacementRatio: string | null;
  onPromotion: boolean;
  brand?: string | null;
  alternates?: Alternate[];
  /** Computed by the model, not by code. */
  saving: number;
  savingPct: number;
  /** Surfaces a "check the pack size" warning in the Telegram card. */
  verifySize: boolean;
  aiReason?: string | null;
  aiConfidence?: number | null;
  aiSource?: string | null;
}

export interface PlanSummary {
  itemsAnalyzed: number;
  replacementsFound: number;
  promotionsUsed: number;
  originalTotal: number;
  optimizedTotal: number;
  saving: number;
  savingPct: number;
  /** Potential only — never counted as guaranteed saving. */
  bonusAvailable: number;
}

export interface OptimizationPlan {
  replacements: Replacement[];
  rejectedByAI?: Replacement[];
  summary: PlanSummary;
}

export interface ParsedSize {
  value: number;
  unit: "g" | "ml";
}
