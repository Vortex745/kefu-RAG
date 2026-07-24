import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { MinerUParser, normalizeMinerU, publishImageAsset } from "./mineru"

test("MinerU content list preserves Chinese OCR, layout, and image evidence", () => {
  const blocks = normalizeMinerU([
    {
      type: "text",
      text: "服务协议",
      text_level: 1,
      bbox: [80, 100, 920, 160],
      page_idx: 0,
    },
    {
      type: "text",
      text: "退款申请应在三十日内提交。",
      bbox: [80, 180, 920, 260],
      page_idx: 0,
    },
    {
      type: "equation",
      text: "$$x+y=1$$",
      text_format: "latex",
      bbox: [80, 280, 500, 340],
      page_idx: 0,
    },
    {
      type: "table",
      table_caption: ["退款期限"],
      table_body: "<table><tr><td>地区</td><td>天数</td></tr></table>",
      bbox: [80, 360, 920, 600],
      page_idx: 1,
    },
    {
      type: "image",
      img_path: "images/diagram.jpg",
      image_caption: ["退款流程图"],
      image_footnote: [],
      bbox: [80, 620, 920, 900],
      page_idx: 1,
    },
  ], "scan-v1", "ocr")

  assert.deepEqual(blocks.map(({ index, type, page }) => [index, type, page]), [
    [0, "heading", 1],
    [1, "paragraph", 1],
    [2, "equation", 1],
    [3, "table", 2],
    [4, "image", 2],
  ])
  assert.equal(blocks[0].headingLevel, 1)
  assert.deepEqual(blocks[1].sectionPath, ["服务协议"])
  assert.deepEqual(blocks[3].table, {
    html: "<table><tr><td>地区</td><td>天数</td></tr></table>",
    captions: ["退款期限"],
  })
  assert.deepEqual(blocks[4].image, {
    sourceReference: "images/diagram.jpg",
    captions: ["退款流程图"],
  })
  assert.ok(blocks.every(({ metadata }) => metadata.ocr === true))
  assert.ok(blocks.every(({ provenance }) => provenance.parser === "mineru"))
})

test("MinerU rejects unsafe references and malformed content-list fields", () => {
  assert.throws(() => normalizeMinerU({ error: "bad output" }, "scan-v1"), /malformed MinerU output/)
  assert.throws(() => normalizeMinerU([{
    type: "text",
    text: "bad page",
    bbox: [0, 0, 1, 1],
    page_idx: -1,
  }], "scan-v1"), /malformed MinerU output/)
  assert.throws(() => normalizeMinerU([{
    type: "code",
    sub_type: "x".repeat(100),
    code_body: "print('safe')",
    bbox: [0, 0, 1, 1],
    page_idx: 0,
  }], "scan-v1"), /malformed MinerU output/)
  assert.throws(() => normalizeMinerU([
    {
      type: "header",
      text: "ignored but malformed",
      bbox: [0, 0, 1],
      page_idx: -1,
    },
    {
      type: "text",
      text: "valid body",
      bbox: [0, 0, 1, 1],
      page_idx: 0,
    },
  ], "scan-v1"), /malformed MinerU output/)
  assert.throws(() => normalizeMinerU([{
    type: "image",
    img_path: "../private.png",
    image_caption: ["unsafe"],
    bbox: [0, 0, 1, 1],
    page_idx: 0,
  }], "scan-v1"), /malformed MinerU output/)
})

test("MinerU accepts official image-only equation and table fallbacks", () => {
  const blocks = normalizeMinerU([
    {
      type: "equation",
      img_path: "images/equation.jpg",
      page_idx: 0,
    },
    {
      type: "table",
      img_path: "images/table.jpg",
      table_caption: ["扫描表格"],
      table_footnote: [],
      page_idx: 0,
    },
  ], "scan-v1")
  assert.equal(blocks[0].text, "Equation on page 1")
  assert.equal(blocks[0].boundingBox, undefined)
  assert.equal(blocks[0].metadata.sourceReference, "images/equation.jpg")
  assert.deepEqual(blocks[1].table, {
    captions: ["扫描表格"],
    sourceReference: "images/table.jpg",
  })
})

test("MinerU accepts analyzed images without an artifact path", () => {
  const blocks = normalizeMinerU([
    {
      type: "image",
      img_path: "",
      image_caption: ["客服流程"],
      page_idx: 0,
    },
    {
      type: "chart",
      img_path: "",
      content: "本月咨询量上升。",
      page_idx: 1,
    },
  ], "scan-v1")

  assert.equal(blocks[0].text, "客服流程")
  assert.deepEqual(blocks[0].image, { captions: ["客服流程"] })
  assert.equal(blocks[1].text, "本月咨询量上升。")
  assert.deepEqual(blocks[1].image, { captions: [] })

  assert.throws(() => normalizeMinerU([{
    type: "image",
    page_idx: 0,
  }], "scan-v1"), /malformed MinerU output/)
  assert.throws(() => normalizeMinerU([{
    type: "table",
    table_body: 42,
    table_caption: ["invalid body"],
    page_idx: 0,
  }], "scan-v1"), /malformed MinerU output/)

  const table = normalizeMinerU([{
    type: "table",
    img_path: "",
    table_body: "<table><tr><td>可用</td></tr></table>",
    page_idx: 0,
  }], "scan-v1")
  assert.deepEqual(table[0].table, {
    html: "<table><tr><td>可用</td></tr></table>",
  })
})

test("MinerU CLI is argument-safe and reports capability failures", async (t) => {
  const writeArtifact = [
    "const fs=require('fs'),path=require('path');",
    "const a=process.argv.slice(1),o=a[a.indexOf('-o')+1];",
    "const d=path.join(o,'input','ocr');fs.mkdirSync(d,{recursive:true});",
    "fs.writeFileSync(path.join(d,'input_content_list.json'),JSON.stringify([{type:'text',text:'OCR result',bbox:[0,0,1,1],page_idx:0}]));",
  ].join("")
  const parser = new MinerUParser({
    command: process.execPath,
    commandArgs: ["-e", writeArtifact, "--"],
    timeoutMs: 1_000,
    inputLimitBytes: 4_096,
    outputLimitBytes: 4_096,
  })
  const blocks = await parser.parse({
    content: Buffer.from("fake image"),
    fileName: "scan; echo injected.png",
    mimeType: "image/png",
    documentId: "scan-v1",
  })
  assert.deepEqual(blocks.map(({ text }) => text), ["OCR result"])

  await t.test("unavailable executable", async () => {
    const unavailable = new MinerUParser({
      command: "kefu-rag-definitely-missing-mineru",
      timeoutMs: 1_000,
      inputLimitBytes: 1_024,
      outputLimitBytes: 1_024,
    })
    await assert.rejects(
      unavailable.parse({
        content: Buffer.from("image"),
        fileName: "scan.png",
        documentId: "scan-v1",
      }),
      /MinerU executable is unavailable/
    )
  })

  await t.test("malformed content list", async () => {
    const malformed = new MinerUParser({
      command: process.execPath,
      commandArgs: [
        "-e",
        "const fs=require('fs'),path=require('path'),a=process.argv.slice(1),o=a[a.indexOf('-o')+1],d=path.join(o,'input','ocr');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'input_content_list.json'),'{')",
        "--",
      ],
      timeoutMs: 1_000,
      inputLimitBytes: 1_024,
      outputLimitBytes: 1_024,
    })
    await assert.rejects(
      malformed.parse({
        content: Buffer.from("image"),
        fileName: "scan.png",
        documentId: "scan-v1",
      }),
      /malformed MinerU output/
    )
  })

  await t.test("missing content list", async () => {
    const missing = new MinerUParser({
      command: process.execPath,
      commandArgs: ["-e", "", "--"],
      timeoutMs: 1_000,
      inputLimitBytes: 1_024,
      outputLimitBytes: 1_024,
    })
    await assert.rejects(
      missing.parse({
        content: Buffer.from("image"),
        fileName: "scan.png",
        documentId: "scan-v1",
      }),
      /malformed MinerU output: expected one result artifact/
    )
  })

  await t.test("missing referenced image", async () => {
    const missingImage = new MinerUParser({
      command: process.execPath,
      commandArgs: [
        "-e",
        "const fs=require('fs'),path=require('path'),a=process.argv.slice(1),o=a[a.indexOf('-o')+1],d=path.join(o,'input','ocr');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'input_content_list.json'),JSON.stringify([{type:'image',img_path:'images/missing.jpg',image_caption:['missing'],bbox:[0,0,1,1],page_idx:0}]))",
        "--",
      ],
      timeoutMs: 1_000,
      inputLimitBytes: 1_024,
      outputLimitBytes: 4_096,
    })
    await assert.rejects(
      missingImage.parse({
        content: Buffer.from("image"),
        fileName: "scan.png",
        documentId: "scan-v1",
      }),
      /malformed MinerU output: referenced image does not exist/
    )
  })
})

test("MinerU persists referenced image bytes under a content-addressed identity", async () => {
  const assetRoot = await mkdtemp(join(tmpdir(), "kefu-rag-assets-test-"))
  const imageBytes = Buffer.from("stable-image-bytes")
  const digest = createHash("sha256").update(imageBytes).digest("hex")
  const writeArtifact = [
    "const fs=require('fs'),path=require('path');",
    "const a=process.argv.slice(1),o=a[a.indexOf('-o')+1];",
    "const d=path.join(o,'input','ocr'),i=path.join(d,'images');fs.mkdirSync(i,{recursive:true});",
    `fs.writeFileSync(path.join(i,'diagram.jpg'),Buffer.from('${imageBytes.toString("base64")}','base64'));`,
    "fs.writeFileSync(path.join(d,'input_content_list.json'),JSON.stringify([{type:'image',img_path:'images/diagram.jpg',image_caption:['退款流程图'],bbox:[0,0,1,1],page_idx:1}]));",
  ].join("")
  const parser = new MinerUParser({
    command: process.execPath,
    commandArgs: ["-e", writeArtifact, "--"],
    timeoutMs: 1_000,
    inputLimitBytes: 4_096,
    outputLimitBytes: 4_096,
    assetRoot,
  })

  try {
    const first = await parser.parse({
      content: Buffer.from("fake scan"),
      fileName: "scan.png",
      documentId: "scan-v1",
    })
    const second = await parser.parse({
      content: Buffer.from("fake scan"),
      fileName: "scan.png",
      documentId: "scan-v1",
    })

    assert.equal(first[0].image?.assetId, `sha256:${digest}`)
    assert.equal(first[0].image?.assetPath, `${digest}.jpg`)
    assert.deepEqual(second[0].image, first[0].image)
    assert.deepEqual(await readFile(join(assetRoot, `${digest}.jpg`)), imageBytes)
  } finally {
    await rm(assetRoot, { recursive: true, force: true })
  }
})

test("content-addressed image publication is atomic under concurrent retries", async () => {
  const assetRoot = await mkdtemp(join(tmpdir(), "kefu-rag-assets-race-"))
  const imageBytes = Buffer.alloc(512 * 1024, 0x5a)
  try {
    const assets = await Promise.all(Array.from({ length: 16 }, () =>
      publishImageAsset(imageBytes, "images/diagram.jpg", assetRoot)
    ))
    assert.equal(new Set(assets.map(({ assetId }) => assetId)).size, 1)
    assert.equal(new Set(assets.map(({ assetPath }) => assetPath)).size, 1)
    assert.deepEqual(await readFile(join(assetRoot, assets[0].assetPath)), imageBytes)
  } finally {
    await rm(assetRoot, { recursive: true, force: true })
  }
})
