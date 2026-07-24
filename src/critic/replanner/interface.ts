import type { CriticVerdict, Query } from "../../types"

export interface RePlanner {
  replan(verdict: CriticVerdict): Promise<Query[]>
}
