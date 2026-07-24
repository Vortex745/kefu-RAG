import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { openDb } from "../ingestion/tracking/db"
import { createApp } from "./server"
import type { AnswerEventsSource } from "./chat"

const eventsSource: AnswerEventsSource = async function* () {}

test("image asset lookup serves only content-addressed files", async (t) => {
  const assetRoot = await mkdtemp(join(tmpdir(), "kefu-rag-api-assets-"))
  const digest = "a".repeat(64)
  const assetPath = `${digest}.jpg`
  const bytes = Buffer.from("image-evidence")
  await writeFile(join(assetRoot, assetPath), bytes)
  const db = openDb(":memory:")
  const server = createApp({ db, imageAssetPath: assetRoot, eventsSource }).listen(0)
  t.after(async () => {
    server.close()
    db.close()
    await rm(assetRoot, { recursive: true, force: true })
  })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const { port } = server.address() as AddressInfo

  const response = await fetch(`http://127.0.0.1:${port}/api/assets/${assetPath}`)
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)

  const invalid = await fetch(`http://127.0.0.1:${port}/api/assets/diagram.jpg`)
  assert.equal(invalid.status, 404)
})
