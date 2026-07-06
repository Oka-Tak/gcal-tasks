/** お金管理のカテゴリ定義 — client/server 両方から import される（DB依存なし）。 */

export const EXPENSE_CATEGORIES = [
  "food", "cafe", "daily", "transport", "fun", "book", "sub", "social", "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<string, string> = {
  food: "🍙 食費",
  cafe: "☕ カフェ・間食",
  daily: "🧺 日用品",
  transport: "🚃 交通",
  fun: "🎮 娯楽",
  book: "📚 書籍・学習",
  sub: "🔁 サブスク",
  social: "🍻 交際",
  other: "📦 その他",
};

export function isExpenseCategory(c: unknown): c is ExpenseCategory {
  return typeof c === "string" && (EXPENSE_CATEGORIES as readonly string[]).includes(c);
}
