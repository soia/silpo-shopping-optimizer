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
  /** Navigational only: a promoted runner-up is named in the result message. */
  slug: string | null;
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
  /**
   * The two product slugs, carried so the card can link each name to its Silpo
   * page. Purely navigational — nothing in the engine reads them.
   */
  originalSlug: string | null;
  originalPrice: number;
  originalRatio: string | null;
  quantity: number;
  replacementProductId: string;
  replacementCompanyId: string;
  replacementBranchId: string;
  replacementName: string;
  replacementSlug: string | null;
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
  /** Confidence at or above `CONFIDENT`: ticked by default, shown without a caveat. */
  confident?: boolean;
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
  /**
   * Discounts Silpo has **already** taken off this cart — `calculation.subDiscount`.
   *
   * Reported beside the saving and never added to it. A cart line carries
   * `oldPrice` as the regular price and `price` with the promotion already
   * applied, so `total` is the discounted figure: counting promotions again as
   * something this run achieved would double-count money the guest already has.
   */
  cartDiscount: number;
  /**
   * Coupons on the account, as a count.
   *
   * A count and not a sum on purpose: `get_my_coupons` says nothing about which
   * coupons apply to this cart or what they are worth, and applying one is a
   * cart write. Shown as an opportunity to act on in the Silpo app.
   */
  couponsAvailable: number;
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
