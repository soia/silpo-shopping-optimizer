/**
 * Domain types, derived from real MCP responses (see `data/mcp-tools.json`
 * and `docs/mcp-reference.md`) — not from the written documentation.
 */

/** A line in the cart. This is the only place the API exposes `ratio` (pack size). */
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
}

/** A product as returned by search tools. Note: no `ratio`, no brand, no category. */
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
  /** Present on cart lines only; kept optional so cart items reuse this shape. */
  ratio?: string | null;
}

export interface LoyaltyInfo {
  bonusAvailable: number;
  bonusTotal?: number;
  bonusRequested?: number | null;
  isEnabled?: boolean;
}

export interface CandidateScores {
  similarityScore: number;
  priceSavingScore: number;
  brandMatchScore: number;
  sizeMatchScore: number;
  promotionScore: number;
  availabilityScore: number;
}

export interface ScoredCandidate {
  productId: string;
  companyId: string;
  branchId: string;
  slug: string;
  name: string;
  price: number;
  oldPrice: number | null;
  ratio: string | null;
  stock: number;
  available: boolean;
  saving: number;
  savingPct: number;
  unitSavingPct: number | null;
  sizeRatio: number | null;
  sameUnitFamily: boolean;
  /** True when neither side exposes a comparable pack size. */
  sizeUnknown: boolean;
  /** Large price drop with unknown pack size — likely a smaller package. */
  suspiciousDrop: boolean;
  /** Fat or content percentage parsed from each name, when present. */
  originalPercent: number | null;
  candidatePercent: number | null;
  /** True when the grades differ beyond PERCENT_TOLERANCE. */
  percentMismatch: boolean;
  onPromotion: boolean;
  /** From `attributes["Торгова марка"]`, filled in when details are fetched. */
  brand?: string | null;
  /** Runners-up, used when the cart reveals the first choice is wrong. */
  alternates?: Array<{ productId: string; companyId: string; branchId: string; name: string; price: number; saving: number; brand: string | null }>;
  scores: CandidateScores;
  finalScore: number;
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
  alternates?: Array<{ productId: string; companyId: string; branchId: string; name: string; price: number; saving: number; brand: string | null }>;
  saving: number;
  savingPct: number;
  finalScore: number;
  scores: CandidateScores;
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

export interface AIDecision {
  index: number;
  accept: boolean;
  confidence: number;
  reason: string;
  source: "ai" | "fallback";
}
