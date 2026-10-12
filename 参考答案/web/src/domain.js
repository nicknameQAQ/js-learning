// 纯数据规则：不依赖页面、localStorage 或服务器，方便单独测试。
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}

export const MAX_PRICE_CENTS = 100000000;
export const SORTS = ["id-asc", "price-asc", "price-desc", "title-asc"];

export function createSeedState() {
  return {
    version: 1,
    nextId: 4,
    books: [
      { id: 1, title: "Java 入门", author: "示例作者 A", priceCents: 5000, available: true },
      { id: 2, title: "JavaScript 实战", author: "示例作者 B", priceCents: 6800, available: true },
      { id: 3, title: "Python 起步", author: "示例作者 C", priceCents: 0, available: false },
    ],
  };
}

// 输入框的“元”转换成整数“分”，避免浮点数参与金额运算。
export function parsePriceCents(value) {
  const text = String(value).trim();
  if (!/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/.test(text)) {
    throw new AppError("价格请输入非负金额，最多两位小数，例如 0、12.30");
  }
  const [yuan, fraction = ""] = text.split(".");
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  if (cents > MAX_PRICE_CENTS) throw new AppError("价格不能超过 1000000.00 元");
  return cents;
}

export function formatPrice(cents) {
  // 存储金额必须是非负整数；显示也不需要浮点除法。
  return String(Math.floor(cents / 100)) + "." + String(cents % 100).padStart(2, "0");
}

export function validateBookInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("图书数据必须是对象");
  }
  const result = {};
  for (const [field, label] of [["title", "书名"], ["author", "作者"]]) {
    if (typeof input[field] !== "string") throw new AppError(label + "必须是文本");
    const value = input[field].trim();
    if (value.length === 0) throw new AppError(label + "不能为空");
    if (value.length > 100) throw new AppError(label + "不能超过 100 个字符");
    result[field] = value;
  }
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents < 0 || input.priceCents > MAX_PRICE_CENTS) {
    throw new AppError("价格必须是 0～100000000 之间的整数分");
  }
  if (typeof input.available !== "boolean") throw new AppError("在售状态必须是 true 或 false");
  return { ...result, priceCents: input.priceCents, available: input.available };
}

export function parseId(value) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new AppError("编号必须是正整数");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new AppError("编号超出安全整数范围");
  return id;
}

function positiveInteger(value, fallback, max, label) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(String(value))) throw new AppError(label + "必须是正整数");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new AppError(label + "超出允许范围");
  return number;
}

export function normalizeQuery(input = {}) {
  const keyword = String(input.keyword ?? "").trim().toLowerCase();
  const available = String(input.available ?? "all");
  const sort = String(input.sort ?? "id-asc");
  if (!["all", "true", "false"].includes(available)) throw new AppError("状态筛选参数不合法");
  if (!SORTS.includes(sort)) throw new AppError("排序参数不合法");
  return {
    keyword,
    available,
    sort,
    page: positiveInteger(input.page, 1, 1000000, "页码"),
    pageSize: positiveInteger(input.pageSize, 5, 50, "每页数量"),
  };
}

export function queryBooks(books, input = {}) {
  const query = normalizeQuery(input);
  const matched = books.filter((book) => {
    const textMatches = book.title.toLowerCase().includes(query.keyword)
      || book.author.toLowerCase().includes(query.keyword);
    const statusMatches = query.available === "all"
      || book.available === (query.available === "true");
    return textMatches && statusMatches;
  });
  const comparisons = {
    "id-asc": (a, b) => a.id - b.id,
    "price-asc": (a, b) => a.priceCents - b.priceCents || a.id - b.id,
    "price-desc": (a, b) => b.priceCents - a.priceCents || a.id - b.id,
    "title-asc": (a, b) => a.title.localeCompare(b.title, "zh-CN") || a.id - b.id,
  };
  // filter 已经生成新数组，所以 sort 不会打乱输入 books。
  matched.sort(comparisons[query.sort]);
  const total = matched.length;
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pages);
  const start = (page - 1) * query.pageSize;
  const stats = matched.reduce((result, book) => ({
    count: result.count + 1,
    availableCount: result.availableCount + Number(book.available),
    totalPriceCents: result.totalPriceCents + book.priceCents,
  }), { count: 0, availableCount: 0, totalPriceCents: 0 });
  return {
    items: matched.slice(start, start + query.pageSize).map((book) => ({ ...book })),
    total,
    page,
    pageSize: query.pageSize,
    pages,
    stats,
  };
}

export function validateStoredState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.books)
      || !Number.isSafeInteger(value.nextId) || value.nextId < 1) {
    throw new AppError("保存的数据结构不正确");
  }
  const ids = new Set();
  const books = value.books.map((book) => {
    const id = parseId(book?.id);
    if (ids.has(id)) throw new AppError("保存的数据包含重复编号");
    if (id >= value.nextId) throw new AppError("保存的数据 nextId 必须大于现有编号");
    ids.add(id);
    return { id, ...validateBookInput(book) };
  });
  return { version: 1, nextId: value.nextId, books };
}

export function addBook(state, input) {
  if (state.nextId >= Number.MAX_SAFE_INTEGER) throw new AppError("编号已用尽，请重置学习数据");
  const book = { id: state.nextId, ...validateBookInput(input) };
  state.books.push(book);
  state.nextId += 1;
  return { ...book };
}

export function getBook(state, idValue) {
  const id = parseId(idValue);
  const book = state.books.find((item) => item.id === id);
  if (!book) throw new AppError("这本图书不存在，可能已被删除", 404);
  return { ...book };
}

export function updateBook(state, idValue, input) {
  const current = getBook(state, idValue);
  const updated = { id: current.id, ...validateBookInput(input) };
  state.books = state.books.map((book) => book.id === current.id ? updated : book);
  return { ...updated };
}

export function removeBook(state, idValue) {
  const current = getBook(state, idValue);
  state.books = state.books.filter((book) => book.id !== current.id);
}

