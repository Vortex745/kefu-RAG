import type { CriticVerdict, Query } from "../../types"

export class RePlannerImpl {
  async replan(verdict: CriticVerdict): Promise<Query[]> {
    if (verdict.passed || !verdict.missingGap) return []
    return [{ text: verdict.missingGap }]
  }
}
