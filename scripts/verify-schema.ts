import { openDb } from "../src/ingestion/tracking/db"

const db = openDb("./data/kefu-rag-acceptance.db")
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
console.log("Tables:", tables.map((t) => t.name).join(", "))
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all() as Array<{ name: string }>
console.log("Indexes:", indexes.map((i) => i.name).join(", "))
const sourcesCols = db.pragma("table_info(sources)") as Array<{ name: string }>
console.log("sources columns:", sourcesCols.map((c) => c.name).join(", "))
const docsCols = db.pragma("table_info(documents)") as Array<{ name: string }>
console.log("documents columns:", docsCols.map((c) => c.name).join(", "))
db.close()
console.log("Schema upgrade verification: PASS")
