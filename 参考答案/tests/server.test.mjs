import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBooksServer } from "../server.mjs";
import { temporaryDirectory, listen, close } from "./helpers.mjs";

const input = { title: "接口测试", author: "测试作者", priceCents: 0, available: false };
const options = (method, body) => ({
  method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("真实 HTTP、持久化与错误协议", async (t) => {
  const directory = await temporaryDirectory();
  let server;
  let base;
  try {
    server = await createBooksServer({ dataDir: directory.path });
    base = await listen(server);

    await t.test("页面与模块可访问、HEAD 不返回正文", async () => {
      const page = await fetch(base);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /我的图书管理/);
      const module = await fetch(base + "/src/main.js");
      assert.match(module.headers.get("content-type"), /javascript/);
      assert.equal(module.status, 200);
      const head = await fetch(base, { method: "HEAD" });
      assert.equal(await head.text(), "");
    });

    await t.test("列表、查单本、新增、修改、删除和 204", async () => {
      let response = await fetch(base + "/api/books?keyword=java");
      let body = await response.json();
      assert.equal(body.code, 0);
      assert.equal(body.data.total, 2);
      response = await fetch(base + "/api/books", options("POST", input));
      assert.equal(response.status, 201);
      const book = (await response.json()).data;
      assert.equal(book.id, 4);
      response = await fetch(base + "/api/books/4");
      assert.equal((await response.json()).data.priceCents, 0);
      response = await fetch(base + "/api/books/4", options("PUT", { ...input, title: "修改后的书" }));
      assert.equal((await response.json()).data.title, "修改后的书");
      response = await fetch(base + "/api/books/4", { method: "DELETE" });
      assert.equal(response.status, 204);
      assert.equal(await response.text(), "");
      response = await fetch(base + "/api/books/4");
      assert.equal(response.status, 404);
    });

    await t.test("错误字段、JSON、类型、查询、方法与大请求", async () => {
      for (const patch of [{ title: "" }, { available: "false" }, { priceCents: 0.5 }]) {
        const response = await fetch(base + "/api/books", options("POST", { ...input, ...patch }));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).data, null);
      }
      const invalidJson = await fetch(base + "/api/books", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
      });
      assert.equal(invalidJson.status, 400);
      assert.equal((await fetch(base + "/api/books", { method: "POST", body: "x" })).status, 415);
      assert.equal((await fetch(base + "/api/books?pageSize=51")).status, 400);
      assert.equal((await fetch(base + "/api/books", options("PATCH"))).status, 405);
      const large = await fetch(base + "/api/books", options("POST", { ...input, title: "x".repeat(20000) }));
      assert.equal(large.status, 413);
      assert.equal((await large.json()).code, 413);
    });

    await t.test("不暴露隐藏数据和路径、拒绝其他来源写请求", async () => {
      assert.equal((await fetch(base + "/.data/books.json")).status, 404);
      assert.equal((await fetch(base + "/%2e%2e%5cserver.mjs")).status, 404);
      assert.equal((await fetch(base + "/api/unknown")).status, 404);
      const response = await fetch(base + "/api/reset", {
        method: "POST", headers: { Origin: "http://other.invalid" },
      });
      assert.equal(response.status, 403);
    });

    await t.test("并发新增编号唯一，修改失败不破坏保存数据", async () => {
      const responses = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        fetch(base + "/api/books", options("POST", { ...input, title: "并发书 " + i })),
      ));
      const books = await Promise.all(responses.map(async (response) => {
        assert.equal(response.status, 201);
        return (await response.json()).data;
      }));
      assert.equal(new Set(books.map((book) => book.id)).size, 8);
      const snapshot = await readFile(join(directory.path, "books.json"), "utf8");
      assert.equal((await fetch(base + "/api/books/9999", options("PUT", input))).status, 404);
      assert.equal(await readFile(join(directory.path, "books.json"), "utf8"), snapshot);
    });

    await t.test("重启恢复记录与递增编号", async () => {
      const before = (await (await fetch(base + "/api/books")).json()).data.total;
      await close(server);
      server = await createBooksServer({ dataDir: directory.path });
      base = await listen(server);
      const result = (await (await fetch(base + "/api/books")).json()).data;
      assert.equal(result.total, before);
      const response = await fetch(base + "/api/books", options("POST", input));
      assert.equal((await response.json()).data.id, 13);
    });

    await t.test("删空、重启不重种，重置才恢复三本", async () => {
      const list = (await (await fetch(base + "/api/books?pageSize=50")).json()).data;
      for (const book of list.items) {
        assert.equal((await fetch(base + "/api/books/" + book.id, { method: "DELETE" })).status, 204);
      }
      await close(server);
      server = await createBooksServer({ dataDir: directory.path });
      base = await listen(server);
      const empty = (await (await fetch(base + "/api/books")).json()).data;
      assert.equal(empty.total, 0);
      assert.equal(empty.pages, 1);
      const reset = await fetch(base + "/api/reset", { method: "POST" });
      assert.equal((await reset.json()).data.total, 3);
    });
  } finally {
    await close(server);
    await directory.cleanup();
  }
});

test("损坏数据文件拒绝启动并保持原文件", async () => {
  const directory = await temporaryDirectory();
  try {
    const path = join(directory.path, "books.json");
    await writeFile(path, "broken", "utf8");
    await assert.rejects(createBooksServer({ dataDir: directory.path }), /数据文件损坏/);
    assert.equal(await readFile(path, "utf8"), "broken");
  } finally { await directory.cleanup(); }
});

test("服务文件写入失败时数据回滚，下一次请求仍能成功", async () => {
  const directory = await temporaryDirectory();
  let server;
  try {
    server = await createBooksServer({ dataDir: directory.path });
    const base = await listen(server);
    // 用一个同名目录阻止临时文件 rename 到目标数据文件。
    const { rename, mkdir, rmdir } = await import("node:fs/promises");
    const dataFile = join(directory.path, "books.json");
    const backupFile = join(directory.path, "backup.json");
    await rename(dataFile, backupFile);
    await mkdir(dataFile);
    const expectedLog = console.error;
    console.error = () => {};
    try {
      const response = await fetch(base + "/api/books", options("POST", input));
      assert.equal(response.status, 500);
      const list = (await (await fetch(base + "/api/books")).json()).data;
      assert.equal(list.total, 3);
    } finally { console.error = expectedLog; }
    // 此路径是已检查的临时测试目录内、刚创建的空目录。
    await rmdir(dataFile);
    await rename(backupFile, dataFile);
    const response = await fetch(base + "/api/books", options("POST", input));
    assert.equal(response.status, 201);
    assert.equal((await response.json()).data.id, 4);
  } finally {
    await close(server);
    await directory.cleanup();
  }
});

