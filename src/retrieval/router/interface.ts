import type { Query, RouterDecision } from "../../types"

export interface Router {
  decide(query: Query): Promise<RouterDecision>
}
