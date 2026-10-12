import test from "node:test";
import assert from "node:assert/strict";
import { createLocalRepository, STORAGE_KEY } from "../web/src/storage.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
  };
}
const input = { title: "测试书", author: "作者", priceCents: 0, available: false };

test("本地初始化一次，重新创建保存层仍可读到修改", async () => {
  const storage = memoryStorage();
  const first = createLocalRepository(storage);
  assert.equal((await first.list()).total, 3);
  const added = await first.add(input);
  await first.update(added.id, { ...input, title: "改名" });
  const reloaded = createLocalRepository(storage);
  assert.equal((await reloaded.list()).total, 4);
  assert.equal((await reloaded.get(added.id)).title, "改名");
});

test("删空数据后刷新不自动恢复示例", async () => {
  const storage = memoryStorage();
  const repository = createLocalRepository(storage);
  for (const book of (await repository.list()).items) await repository.remove(book.id);
  assert.equal((await createLocalRepository(storage).list()).total, 0);
  assert.equal((await repository.add(input)).id, 4);
});

test("损坏 JSON、结构错误保持原字符串；确认重置才覆盖", async () => {
  const storage = memoryStorage();
  const repository = createLocalRepository(storage);
  for (const broken of ["broken", '{"version":1,"nextId":4,"books":[{}]}']) {
    storage.setItem(STORAGE_KEY, broken);
    await assert.rejects(repository.list(), /损坏/);
    await assert.rejects(repository.add(input), /损坏/);
    assert.equal(storage.getItem(STORAGE_KEY), broken);
  }
  await repository.reset();
  assert.equal((await repository.list()).total, 3);
});

test("保存失败不产生只能在内存看到的记录", async () => {
  const storage = memoryStorage();
  const repository = createLocalRepository(storage);
  await repository.list();
  const snapshot = storage.getItem(STORAGE_KEY);
  const originalSet = storage.setItem;
  storage.setItem = () => { throw new Error("quota"); };
  await assert.rejects(repository.add(input), /无法保存/);
  assert.equal(storage.getItem(STORAGE_KEY), snapshot);
  storage.setItem = originalSet;
  assert.equal((await repository.list()).total, 3);
});

test("无法读浏览器存储时提供明确提示", async () => {
  await assert.rejects(createLocalRepository(undefined).list(), /无法读取/);
});

