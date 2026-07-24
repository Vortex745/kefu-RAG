import neo4j, { Driver } from "neo4j-driver"
import { loadConfig } from "../config"

let _driver: Driver | null = null

export function createDriver(): Driver {
  if (_driver) return _driver
  const cfg = loadConfig()
  _driver = neo4j.driver(cfg.neo4jUri, neo4j.auth.basic(cfg.neo4jUser, cfg.neo4jPassword))
  return _driver
}

export function getDriver(): Driver {
  if (!_driver) throw new Error("Neo4j driver not initialized. Call createDriver() first.")
  return _driver
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close()
    _driver = null
  }
}
