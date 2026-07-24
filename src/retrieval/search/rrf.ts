import type { RetrievalResult } from "../../types"

const K = 60

export function rrf(resultSets: RetrievalResult[][]): RetrievalResult[] {
  const scores = new Map<string, { result: RetrievalResult; rankSum: number }>()

  for (const results of resultSets) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const key = `${r.chunk.documentId}\0${r.chunk.id}`
      const inc = 1 / (K + i + 1)
      if (scores.has(key)) {
        const entry = scores.get(key)!
        entry.rankSum += inc
        const channels = new Set([
          ...(entry.result.channels ?? [entry.result.source]),
          ...(r.channels ?? [r.source]),
        ])
        entry.result.channels = [...channels]
        for (const link of r.wikilinks) {
          const existing = entry.result.wikilinks.find((candidate) =>
            candidate.sourceEntityId === link.sourceEntityId &&
            candidate.targetEntityId === link.targetEntityId &&
            candidate.relation === link.relation
          )
          if (existing) {
            existing.weight = Math.max(existing.weight, link.weight)
            existing.provenance = [...new Map([
              ...(existing.provenance ?? []),
              ...(link.provenance ?? []),
            ].map((item) => [`${item.documentId}\0${item.chunkId}`, item])).values()]
          }
          else entry.result.wikilinks.push({ ...link })
        }
        if (
          entry.result.chunk.metadata.graphPath === undefined &&
          r.chunk.metadata.graphPath !== undefined
        ) {
          entry.result.chunk.metadata.graphPath = r.chunk.metadata.graphPath
        }
      } else {
        scores.set(key, {
          result: {
            ...r,
            channels: [...(r.channels ?? [r.source])],
            chunk: {
              ...r.chunk,
              metadata: { ...r.chunk.metadata },
            },
            wikilinks: r.wikilinks.map((link) => ({ ...link })),
          },
          rankSum: inc,
        })
      }
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1].rankSum - a[1].rankSum)
    .map(([_, v]) => v.result)
}
