import test from "node:test";
import assert from "node:assert/strict";
import {
  createSeedState, parsePriceCents, formatPrice, validateBookInput, validateStoredState,
  queryBooks, addBook, getBook, updateBook, removeBook,
} from "../web/src/domain.js";

test("金额精确转换：零、一位和两位小数以及上限", () => {
  for (const [input, expected] of [["0", 0], ["0.00", 0], ["12.3", 1230], ["12.34", 1234], ["0.29", 29], ["1000000.00", 100000000]]) {
    assert.equal(parsePriceCents(input), expected);
  }
  assert.equal(formatPrice(0), "0.00");
  assert.equal(formatPrice(29), "0.29");
  assert.equal(formatPrice(1234), "12.34");
});

test("金额拒绝空、负数、科学计数法、三位小数和越界", () => {
  for (const input of ["", " ", "-1", "1e2", "12.345", "1000000.01", "01", ".5", "1.", "NaN", "1,000", "Infinity"]) {
    assert.throws(() => parsePriceCents(input), undefined, input);
  }
});

test("字段去空白并保留有效的零价格、停售", () => {
  const book = validateBookInput({ title: "  JS  ", author: "  作者  ", priceCents: 0, available: false });
  assert.deepEqual(book, { title: "JS", author: "作者", priceCents: 0, available: false });
  for (const patch of [{ title: " " }, { author: "" }, { title: "a".repeat(101) }, { priceCents: 1.5 }, { priceCents: -1 }, { available: "false" }]) {
    assert.throws(() => validateBookInput({ ...book, ...patch }));
  }
});

test("搜索书名和作者、状态组合、忽略大小写", () => {
  const books = createSeedState().books;
  assert.equal(queryBooks(books, { keyword: " JAVA " }).total, 2);
  assert.equal(queryBooks(books, { keyword: "示例作者 c", available: "false" }).total, 1);
  assert.equal(queryBooks(books, { keyword: "java", available: "false" }).total, 0);
});

test("排序稳定、结果对象独立且不修改输入", () => {
  const books = [
    { id: 2, title: "A", author: "作者", priceCents: 100, available: true },
    { id: 1, title: "A", author: "作者", priceCents: 100, available: true },
    { id: 3, title: "B", author: "作者", priceCents: 0, available: false },
  ];
  const snapshot = structuredClone(books);
  assert.deepEqual(queryBooks(books, { sort: "price-asc" }).items.map((b) => b.id), [3, 1, 2]);
  assert.deepEqual(queryBooks(books, { sort: "price-desc" }).items.map((b) => b.id), [1, 2, 3]);
  assert.deepEqual(queryBooks(books, { sort: "title-asc" }).items.map((b) => b.id), [1, 2, 3]);
  const result = queryBooks(books);
  result.items[0].title = "改写返回对象";
  assert.deepEqual(books, snapshot);
});

test("分页统计覆盖所有匹配记录，越界页收拢，空列表固定一页", () => {
  const books = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1, title: "书 " + index, author: "作者", priceCents: 100, available: index < 6,
  }));
  const second = queryBooks(books, { page: 2, pageSize: 5 });
  assert.equal(second.items.length, 3);
  assert.deepEqual(second.stats, { count: 8, availableCount: 6, totalPriceCents: 800 });
  assert.equal(queryBooks(books, { page: 999 }).page, 2);
  const empty = queryBooks([], { page: 99 });
  assert.equal(empty.page, 1);
  assert.equal(empty.pages, 1);
  assert.deepEqual(empty.items, []);
});

test("非法查询参数被拒绝，不默默变成默认值", () => {
  for (const query of [{ page: 0 }, { page: "1e2" }, { page: 1000001 }, { pageSize: 51 }, { pageSize: "" }, { available: "yes" }, { sort: "bad" }]) {
    assert.throws(() => queryBooks([], query));
  }
});

test("新增同名、编辑保留编号、删除后不重用编号、未找到不误删", () => {
  const state = createSeedState();
  const input = { title: "Java 入门", author: "另一位作者", priceCents: 0, available: false };
  const book = addBook(state, input);
  assert.equal(book.id, 4);
  const edited = updateBook(state, 4, { ...input, title: "编辑后" });
  assert.equal(edited.id, 4);
  removeBook(state, 4);
  assert.equal(addBook(state, input).id, 5);
  const before = structuredClone(state);
  assert.throws(() => removeBook(state, 999), (e) => e.status === 404);
  assert.throws(() => getBook(state, "01"));
  assert.deepEqual(state, before);
});

test("存储结构校验拒绝重复编号、回退序号、缺字段和非法版本", () => {
  const seed = createSeedState();
  assert.deepEqual(validateStoredState(seed), seed);
  const duplicate = structuredClone(seed);
  duplicate.books.push({ ...duplicate.books[0] });
  assert.throws(() => validateStoredState(duplicate));
  assert.throws(() => validateStoredState({ ...seed, nextId: 3 }));
  assert.throws(() => validateStoredState({ ...seed, version: 2 }));
  assert.throws(() => validateStoredState({ books: [] }));
});

