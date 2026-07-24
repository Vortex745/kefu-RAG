import assert from "node:assert/strict"
import test from "node:test"
import { MarkItDownParser } from "./markitdown"
import { MarkerParser, normalizeMarker } from "./marker"
import { normalizeMarkItDown } from "./normalize"
import { runBoundedProcess } from "./process"
import { selectParser } from "./router"

test("common documents route to MarkItDown and explicit override records its reason", () => {
  assert.deepEqual(
    selectParser({ fileName: "policy.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    { parser: "markitdown", reason: "extension .docx is supported by MarkItDown" }
  )
  assert.deepEqual(
    selectParser({
      fileName: "paper.pdf",
      mimeType: "application/pdf",
      override: "markitdown",
    }),
    { parser: "markitdown", reason: "explicit parser override" }
  )
  assert.deepEqual(
    selectParser({ fileName: "paper.pdf", mimeType: "text/plain" }),
    { parser: "marker", reason: "PDF documents require layout-aware parsing" }
  )
  assert.deepEqual(
    selectParser({ fileName: "scan.png", mimeType: "image/png" }),
    { parser: "mineru", reason: "image documents require OCR-aware parsing" }
  )
  assert.deepEqual(
    selectParser({ fileName: "scan.pdf", override: "mineru" }),
    { parser: "mineru", reason: "explicit parser override" }
  )
})

test("MarkItDown output becomes validated ordered blocks with stable provenance", () => {
  const markdown = [
    "# Refund policy",
    "",
    "Refunds are available within 30 days.",
    "",
    "| Region | Window |",
    "| --- | --- |",
    "| CN | 30 days |",
    "",
    "```json",
    "{\"window\":30}",
    "```",
  ].join("\n")

  const first = normalizeMarkItDown(markdown, "doc-v1")
  const second = normalizeMarkItDown(markdown, "doc-v1")

  assert.deepEqual(first, second)
  assert.deepEqual(first.map(({ index, type }) => [index, type]), [
    [0, "heading"],
    [1, "paragraph"],
    [2, "table"],
    [3, "code"],
  ])
  assert.equal(first[0].headingLevel, 1)
  assert.deepEqual(first[1].sectionPath, ["Refund policy"])
  assert.deepEqual(first[2].table, {
    headers: ["Region", "Window"],
    rows: [["CN", "30 days"]],
  })
  assert.equal(first[3].metadata.language, "json")
  assert.ok(first.every((block) => block.provenance.parser === "markitdown"))
  assert.equal(new Set(first.map(({ id }) => id)).size, first.length)

  const skippedHeading = normalizeMarkItDown("### Deep section\n\nBody", "doc-v2")
  assert.deepEqual(skippedHeading[0].sectionPath, ["Deep section"])
  assert.ok(skippedHeading.every((block) => block.sectionPath.every(
    (part) => typeof part === "string"
  )))
})

test("MarkItDown reports an unavailable executable actionably", async () => {
  const parser = new MarkItDownParser({
    command: "kefu-rag-definitely-missing-markitdown",
    timeoutMs: 1_000,
    inputLimitBytes: 1_024,
    outputLimitBytes: 1_024,
  })

  await assert.rejects(
    parser.parse({
      content: Buffer.from("hello"),
      fileName: "policy.txt",
      mimeType: "text/plain",
      documentId: "doc-v1",
    }),
    /MarkItDown executable is unavailable/
  )
})

test("bounded parser processes time out, cancel, and reject oversized output", async (t) => {
  await t.test("pre-cancelled signal", async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await Promise.race([
      runBoundedProcess({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 5_000,
        outputLimitBytes: 1_024,
        signal: controller.signal,
      }).then(
        () => "resolved",
        (error: Error) => error.message
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 500)),
    ])
    assert.match(outcome, /cancelled/)
  })

  await t.test("timeout", async () => {
    await assert.rejects(
      runBoundedProcess({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 100,
        outputLimitBytes: 1_024,
      }),
      /timed out after 100ms/
    )
  })

  await t.test("cancellation", async () => {
    const controller = new AbortController()
    const running = runBoundedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 5_000,
      outputLimitBytes: 1_024,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(running, /cancelled/)
  })

  await t.test("output limit", async () => {
    await assert.rejects(
      runBoundedProcess({
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        timeoutMs: 1_000,
        outputLimitBytes: 128,
      }),
      /output exceeded 128 bytes/
    )
  })

  await t.test("actionable stderr tail", async () => {
    await assert.rejects(
      runBoundedProcess({
        command: process.execPath,
        args: [
          "-e",
          "let count=0; const timer=setInterval(() => { if (count++ < 20) process.stderr.write('trace '.repeat(200)); else { clearInterval(timer); process.stderr.write('ROOT_CAUSE incompatible runtime'); process.exit(1); } }, 5)",
        ],
        timeoutMs: 1_000,
        outputLimitBytes: 1_024,
      }),
      /ROOT_CAUSE incompatible runtime/
    )
  })
})

test("MarkItDown invocation is argument-safe and malformed output is rejected", async (t) => {
  await t.test("argument-safe filename", async () => {
    const parser = new MarkItDownParser({
      command: process.execPath,
      commandArgs: ["-e", "process.stdout.write('# Safe output\\n\\nParsed')"],
      timeoutMs: 1_000,
      inputLimitBytes: 1_024,
      outputLimitBytes: 1_024,
    })
    const blocks = await parser.parse({
      content: Buffer.from("source"),
      fileName: "policy; echo injected.txt",
      mimeType: "text/plain",
      documentId: "doc-v1",
    })
    assert.deepEqual(blocks.map(({ text }) => text), ["Safe output", "Parsed"])
  })

  await t.test("malformed output", async () => {
    const parser = new MarkItDownParser({
      command: process.execPath,
      commandArgs: ["-e", "process.stdout.write('```json\\n{')"],
      timeoutMs: 1_000,
      inputLimitBytes: 1_024,
      outputLimitBytes: 1_024,
    })
    await assert.rejects(
      parser.parse({
        content: Buffer.from("source"),
        fileName: "policy.txt",
        mimeType: "text/plain",
        documentId: "doc-v1",
      }),
      /malformed MarkItDown output/
    )
  })
})

test("Marker preserves reading order, headings, equations, tables, and pages", () => {
  const blocks = normalizeMarker({
    block_type: "Document",
    metadata: {},
    children: [{
      id: "/page/0/Page/0",
      block_type: "Page",
      html: "<content-ref src='/page/0/SectionHeader/0'></content-ref>",
      bbox: [0, 0, 612, 792],
      polygon: [[0, 0], [612, 0], [612, 792], [0, 792]],
      children: [
        {
          id: "/page/0/SectionHeader/0",
          block_type: "SectionHeader",
          html: "<h2>Methods</h2>",
          bbox: [20, 30, 200, 60],
          polygon: [[20, 30], [200, 30], [200, 60], [20, 60]],
          children: null,
          section_hierarchy: { "2": "/page/0/SectionHeader/0" },
          images: {},
        },
        {
          id: "/page/0/Text/1",
          block_type: "Text",
          html: "<p>We compare both methods.</p>",
          bbox: [20, 70, 500, 100],
          polygon: [[20, 70], [500, 70], [500, 100], [20, 100]],
          children: null,
          section_hierarchy: { "2": "/page/0/SectionHeader/0" },
          images: {},
        },
        {
          id: "/page/0/Equation/2",
          block_type: "Equation",
          html: "<math>E = mc^2</math>",
          bbox: [20, 110, 300, 150],
          polygon: [[20, 110], [300, 110], [300, 150], [20, 150]],
          children: null,
          section_hierarchy: { "2": "/page/0/SectionHeader/0" },
          images: {},
        },
        {
          id: "/page/0/Table/3",
          block_type: "Table",
          html: "<table><tr><td>A</td><td>B</td></tr></table>",
          bbox: [20, 160, 400, 260],
          polygon: [[20, 160], [400, 160], [400, 260], [20, 260]],
          children: null,
          section_hierarchy: { "2": "/page/0/SectionHeader/0" },
          images: {},
        },
      ],
    }],
  }, "paper-v1")

  assert.deepEqual(blocks.map(({ index, type, page }) => [index, type, page]), [
    [0, "heading", 1],
    [1, "paragraph", 1],
    [2, "equation", 1],
    [3, "table", 1],
  ])
  assert.equal(blocks[0].headingLevel, 2)
  assert.equal(blocks[0].text, "Methods")
  assert.equal(blocks[2].text, "E = mc^2")
  assert.deepEqual(blocks[1].sectionPath, ["Methods"])
  assert.deepEqual(blocks[3].table, {
    html: "<table><tr><td>A</td><td>B</td></tr></table>",
  })
  assert.ok(blocks.every(({ provenance }) => provenance.parser === "marker"))
})

test("Marker rejects schema-invalid output and does not expose raw image payloads", () => {
  assert.throws(
    () => normalizeMarker({ text: "provider error" }, "paper-v1"),
    /malformed Marker output/
  )
  const validLeaf = {
    id: "/page/0/Text/0",
    block_type: "Text",
    html: "<p>valid child</p>",
    bbox: [0, 0, 1, 1],
    polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
    children: null,
  }
  assert.throws(
    () => normalizeMarker({
      block_type: "Document",
      metadata: {},
      children: [{ ...validLeaf }],
    }, "paper-v1"),
    /malformed Marker output/
  )
  assert.throws(
    () => normalizeMarker({
      block_type: "Document",
      metadata: {},
      children: [{
        id: "invalid-group-id",
        block_type: "UnsupportedGroup",
        html: "<content-ref src='/page/0/Text/0'></content-ref>",
        bbox: [0, 0, 1, 1],
        polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
        children: [validLeaf],
      }],
    }, "paper-v1"),
    /malformed Marker output/
  )
  assert.throws(
    () => normalizeMarker({
      block_type: "Document",
      metadata: {},
      children: [{
        id: "/page/-1/Text/0",
        block_type: "Text",
        html: "<p>invalid page</p>",
        bbox: [0, 0, 1],
        polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
        children: null,
      }],
    }, "paper-v1"),
    /malformed Marker output/
  )
  assert.throws(
    () => normalizeMarker({
      block_type: "Document",
      metadata: {},
      children: [{
        id: "/page/0/Text/0",
        block_type: "Table",
        html: "<table><tr><td>mismatch</td></tr></table>",
        bbox: [0, 0, 1, 1],
        polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
        children: null,
      }],
    }, "paper-v1"),
    /malformed Marker output/
  )

  const [image] = normalizeMarker({
    block_type: "Document",
    metadata: {},
    children: [{
      id: "/page/0/Page/0",
      block_type: "Page",
      html: "",
      bbox: [0, 0, 100, 100],
      polygon: [[0, 0], [100, 0], [100, 100], [0, 100]],
      children: [{
        id: "/page/0/Picture/0",
        block_type: "Picture",
        html: "<p>Architecture diagram</p><img src='data:image/png;base64,PRIVATE_HTML'>",
        bbox: [0, 0, 100, 100],
        polygon: [[0, 0], [100, 0], [100, 100], [0, 100]],
        children: null,
        section_hierarchy: {},
        images: { "data:image/png;base64,PRIVATE_KEY": "PRIVATE_PAYLOAD" },
        provider_secret: "must-not-leak",
      }],
    }],
  }, "paper-v1")
  assert.deepEqual(image.image, {
    referenceCount: 1,
  })
  assert.doesNotMatch(
    JSON.stringify(image),
    /PRIVATE_HTML|PRIVATE_KEY|PRIVATE_PAYLOAD|must-not-leak/
  )
})

test("Marker accepts the current official leaf block types", () => {
  const children = ["Char", "ComplexRegion", "TableCell", "Reference"].map(
    (blockType, index) => ({
      id: `/page/0/${blockType}/${index}`,
      block_type: blockType,
      html: `<span>${blockType}</span>`,
      bbox: [0, index, 1, index + 1],
      polygon: [[0, index], [1, index], [1, index + 1], [0, index + 1]],
      children: null,
      section_hierarchy: {},
      images: {},
    })
  )
  const blocks = normalizeMarker({
    block_type: "Document",
    metadata: {},
    children: [{
      id: "/page/0/Page/0",
      block_type: "Page",
      html: "",
      bbox: [0, 0, 1, 4],
      polygon: [[0, 0], [1, 0], [1, 4], [0, 4]],
      children,
    }],
  }, "paper-v1")
  assert.deepEqual(blocks.map(({ text }) => text), [
    "Char",
    "ComplexRegion",
    "TableCell",
    "Reference",
  ])
})

test("Marker CLI is argument-safe, bounded, and fails actionably", async (t) => {
  const writeArtifact = [
    "const fs=require('fs'),path=require('path');",
    "const args=process.argv.slice(1);",
    "const output=args[args.indexOf('--output_dir')+1];",
    "const dir=path.join(output,'input');fs.mkdirSync(dir,{recursive:true});",
    "fs.writeFileSync(path.join(dir,'input.json'),JSON.stringify({block_type:'Document',metadata:{},children:[{id:'/page/0/Page/0',block_type:'Page',html:'',bbox:[0,0,1,1],polygon:[[0,0],[1,0],[1,1],[0,1]],children:[{id:'/page/0/Text/0',block_type:'Text',html:'<p>Parsed paper</p>',bbox:[0,0,1,1],polygon:[[0,0],[1,0],[1,1],[0,1]],children:null,section_hierarchy:{},images:{}}]}]}));",
  ].join("")
  const parser = new MarkerParser({
    command: process.execPath,
    commandArgs: ["-e", writeArtifact],
    timeoutMs: 1_000,
    inputLimitBytes: 1_024,
    outputLimitBytes: 1_024,
  })
  const blocks = await parser.parse({
    content: Buffer.from("%PDF-fake"),
    fileName: "paper; echo injected.pdf",
    mimeType: "application/pdf",
    documentId: "paper-v1",
  })
  assert.deepEqual(blocks.map(({ text }) => text), ["Parsed paper"])

  await t.test("unavailable executable", async () => {
    const unavailable = new MarkerParser({
      command: "kefu-rag-definitely-missing-marker",
      timeoutMs: 1_000,
      inputLimitBytes: 1_024,
      outputLimitBytes: 1_024,
    })
    await assert.rejects(
      unavailable.parse({
        content: Buffer.from("%PDF-fake"),
        fileName: "paper.pdf",
        documentId: "paper-v1",
      }),
      /Marker executable is unavailable/
    )
  })

  await t.test("malformed artifact", async () => {
    const malformed = new MarkerParser({
      command: process.execPath,
      commandArgs: [
        "-e",
        "const fs=require('fs'),path=require('path'),a=process.argv.slice(1),o=a[a.indexOf('--output_dir')+1],d=path.join(o,'input');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'input.json'),'{')",
      ],
      timeoutMs: 1_000,
      inputLimitBytes: 1_024,
      outputLimitBytes: 1_024,
    })
    await assert.rejects(
      malformed.parse({
        content: Buffer.from("%PDF-fake"),
        fileName: "paper.pdf",
        documentId: "paper-v1",
      }),
      /malformed Marker output/
    )
  })

  await t.test("aggregate artifact limit", async () => {
    const oversized = new MarkerParser({
      command: process.execPath,
      commandArgs: [
        "-e",
        "const fs=require('fs'),path=require('path'),a=process.argv.slice(1),o=a[a.indexOf('--output_dir')+1],d=path.join(o,'input');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'input.json'),JSON.stringify({block_type:'Document',metadata:{},children:[{id:'/page/0/Text/0',block_type:'Text',html:'<p>ok</p>',bbox:[0,0,1,1],polygon:[[0,0],[1,0],[1,1],[0,1]],children:null}]}));fs.writeFileSync(path.join(d,'extra.bin'),'x'.repeat(2048))",
      ],
      timeoutMs: 1_000,
      inputLimitBytes: 4_096,
      outputLimitBytes: 1_024,
    })
    await assert.rejects(
      oversized.parse({
        content: Buffer.from("%PDF-fake"),
        fileName: "paper.pdf",
        documentId: "paper-v1",
      }),
      /Marker output exceeded 1024 bytes/
    )
  })

  await t.test("running artifact limit", async () => {
    const running = new MarkerParser({
      command: process.execPath,
      commandArgs: [
        "-e",
        "const fs=require('fs'),path=require('path'),a=process.argv.slice(1),o=a[a.indexOf('--output_dir')+1];fs.mkdirSync(o,{recursive:true});const p=path.join(o,'growing.bin');setInterval(()=>fs.appendFileSync(p,'x'.repeat(256)),10)",
      ],
      timeoutMs: 2_000,
      inputLimitBytes: 4_096,
      outputLimitBytes: 512,
    })
    const startedAt = Date.now()
    await assert.rejects(
      running.parse({
        content: Buffer.from("%PDF-fake"),
        fileName: "paper.pdf",
        documentId: "paper-v1",
      }),
      /Marker output exceeded 512 bytes/
    )
    assert.ok(Date.now() - startedAt < 1_500)
  })
})
