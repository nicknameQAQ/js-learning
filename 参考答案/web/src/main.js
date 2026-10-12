import { formatPrice, parsePriceCents, validateBookInput } from "./domain.js";
import { createLocalRepository } from "./storage.js";
import { createApiRepository } from "./api.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  form: $("#book-form"), title: $("#title"), author: $("#author"), price: $("#price"),
  available: $("#available"), formTitle: $("#form-title"), save: $("#save"),
  cancel: $("#cancel-edit"), list: $("#book-list"), listState: $("#list-state"),
  message: $("#message"), mode: $("#mode"), modeNote: $("#mode-note"),
  keyword: $("#keyword"), status: $("#status"), sort: $("#sort"), pageSize: $("#page-size"),
  prev: $("#prev"), next: $("#next"), pageInfo: $("#page-info"),
  count: $("#stat-count"), availableCount: $("#stat-available"), totalPrice: $("#stat-price"),
  formFields: $("#form-fields"), queryFields: $("#query-fields"),
  reload: $("#reload"), reset: $("#reset"),
};

const state = {
  mode: "local", editingId: null, page: 1, pages: 1,
  busy: false, loading: false, requestNumber: 0, controller: null,
};
let repository;
let searchTimer;

function announce(message, kind = "success") {
  elements.message.textContent = message;
  elements.message.dataset.kind = kind;
  elements.message.hidden = !message;
}

function updateButtons() {
  elements.formFields.disabled = state.busy;
  elements.queryFields.disabled = state.busy;
  elements.mode.disabled = state.busy;
  elements.pageSize.disabled = state.busy;
  elements.reset.disabled = state.busy;
  elements.prev.disabled = state.busy || state.loading || state.page <= 1;
  elements.next.disabled = state.busy || state.loading || state.page >= state.pages;
  for (const button of elements.list.querySelectorAll("button")) button.disabled = state.busy;
  elements.save.textContent = state.busy ? "处理中…" : state.editingId === null ? "新增图书" : "保存修改";
}

function setBusy(value) {
  state.busy = value;
  updateButtons();
}

function resetForm() {
  state.editingId = null;
  elements.form.reset();
  elements.formTitle.textContent = "新增图书";
  elements.cancel.hidden = true;
  updateButtons();
}

// 用户输入只填入 textContent。不要把书名直接拼进 innerHTML。
function renderBooks(result) {
  elements.list.replaceChildren();
  for (const book of result.items) {
    const row = document.createElement("tr");
    row.dataset.id = String(book.id);
    const id = document.createElement("td");
    id.textContent = String(book.id);
    const description = document.createElement("td");
    const title = document.createElement("span");
    title.className = "book-title";
    title.textContent = book.title;
    const author = document.createElement("span");
    author.className = "book-author";
    author.textContent = book.author;
    description.append(title, author);
    const price = document.createElement("td");
    price.className = "price-cell";
    price.textContent = "¥ " + formatPrice(book.priceCents);
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = book.available ? "status" : "status off";
    status.textContent = book.available ? "在售" : "停售";
    statusCell.append(status);
    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";
    for (const [action, label] of [["edit", "编辑"], ["delete", "删除"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.dataset.id = String(book.id);
      button.className = action;
      button.textContent = label;
      actions.append(button);
    }
    actionsCell.append(actions);
    row.append(id, description, price, statusCell, actionsCell);
    elements.list.append(row);
  }
  state.page = result.page;
  state.pages = result.pages;
  elements.count.textContent = String(result.stats.count);
  elements.availableCount.textContent = String(result.stats.availableCount);
  elements.totalPrice.textContent = "¥ " + formatPrice(result.stats.totalPriceCents);
  elements.pageInfo.textContent = "第 " + result.page + " / " + result.pages + " 页";
  elements.listState.hidden = result.items.length > 0;
  elements.listState.textContent = result.total === 0
    ? "还没有匹配的图书。试试新增一本，或调整搜索条件。" : "";
}

function queryFromPage() {
  return {
    keyword: elements.keyword.value.trim(),
    available: elements.status.value,
    sort: elements.sort.value,
    page: state.page,
    pageSize: Number(elements.pageSize.value),
  };
}

async function loadBooks() {
  // 同时使用取消和序号：即使旧请求已经完成，也不能覆盖最新结果。
  const number = ++state.requestNumber;
  state.controller?.abort();
  state.controller = new AbortController();
  state.loading = true;
  elements.listState.hidden = false;
  elements.listState.textContent = "加载中…";
  updateButtons();
  try {
    const result = await repository.list(queryFromPage(), { signal: state.controller.signal });
    if (number !== state.requestNumber) return false;
    renderBooks(result);
    return true;
  } catch (error) {
    if (number !== state.requestNumber || error.name === "AbortError") return false;
    // 清空旧视图，避免用户把上一次数据误当成当前查询结果。
    elements.list.replaceChildren();
    elements.count.textContent = "—";
    elements.availableCount.textContent = "—";
    elements.totalPrice.textContent = "—";
    state.page = 1;
    state.pages = 1;
    elements.pageInfo.textContent = "第 1 / 1 页";
    elements.listState.hidden = false;
    elements.listState.textContent = "加载失败，请根据上方提示修复后刷新列表。";
    announce(error.message, "error");
    return false;
  } finally {
    if (number === state.requestNumber) {
      state.loading = false;
      updateButtons();
    }
  }
}

async function switchMode(mode) {
  clearTimeout(searchTimer);
  state.mode = mode;
  state.page = 1;
  resetForm();
  announce("");
  let browserStorage;
  try { browserStorage = window.localStorage; } catch { /* 保存层将给出错误提示。 */ }
  repository = mode === "api" ? createApiRepository() : createLocalRepository(browserStorage);
  elements.mode.value = mode;
  elements.modeNote.textContent = mode === "api"
    ? "接口模式：数据保存在本机 JSON 文件，两种模式相互独立。"
    : "本地模式：数据保存在当前浏览器，两种模式相互独立。";
  let modeWarning = "";
  try { window.localStorage.setItem("js-books-mode", mode); }
  catch { modeWarning = "浏览器无法记住模式选择，请检查存储设置"; }
  await loadBooks();
  if (modeWarning && elements.message.hidden) announce(modeWarning, "error");
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  let input;
  try {
    input = validateBookInput({
      title: elements.title.value,
      author: elements.author.value,
      priceCents: parsePriceCents(elements.price.value),
      available: elements.available.checked,
    });
  } catch (error) {
    announce(error.message, "error");
    return;
  }
  setBusy(true);
  const editing = state.editingId;
  try {
    if (editing === null) await repository.add(input);
    else await repository.update(editing, input);
    clearTimeout(searchTimer);
    if (editing === null) state.page = 1;
    resetForm();
    if (await loadBooks()) announce(editing === null ? "图书已新增" : "修改已保存");
  } catch (error) {
    // 不清空输入，便于修复后重试。
    announce(error.message, "error");
  } finally {
    setBusy(false);
  }
});

elements.cancel.addEventListener("click", () => {
  resetForm();
  announce("已取消编辑");
});

elements.list.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || state.busy) return;
  const id = Number(button.dataset.id);
  if (button.dataset.action === "delete"
      && !window.confirm("确认删除编号 " + id + " 的图书吗？")) return;
  setBusy(true);
  try {
    if (button.dataset.action === "edit") {
      const book = await repository.get(id);
      state.editingId = book.id;
      elements.title.value = book.title;
      elements.author.value = book.author;
      elements.price.value = formatPrice(book.priceCents);
      elements.available.checked = book.available;
      elements.formTitle.textContent = "编辑图书 #" + book.id;
      elements.cancel.hidden = false;
      announce("");
    } else {
      await repository.remove(id);
      clearTimeout(searchTimer);
      if (state.editingId === id) resetForm();
      if (await loadBooks()) announce("图书已删除");
    }
  } catch (error) {
    announce(error.message, "error");
  } finally {
    setBusy(false);
    if (button.dataset.action === "edit") elements.title.focus();
  }
});

function filtersChanged() {
  clearTimeout(searchTimer);
  state.page = 1;
  announce("");
  void loadBooks();
}

elements.keyword.addEventListener("input", () => {
  clearTimeout(searchTimer);
  // 输入刚改变，就作废正在进行的查询，而不是等 250ms 后才作废。
  state.controller?.abort();
  state.requestNumber += 1;
  state.loading = false;
  updateButtons();
  searchTimer = setTimeout(filtersChanged, 250);
});
for (const element of [elements.status, elements.sort, elements.pageSize]) {
  element.addEventListener("change", filtersChanged);
}
elements.prev.addEventListener("click", () => {
  state.page -= 1;
  announce("");
  void loadBooks();
});
elements.next.addEventListener("click", () => {
  state.page += 1;
  announce("");
  void loadBooks();
});
elements.reload.addEventListener("click", () => {
  clearTimeout(searchTimer);
  announce("");
  void loadBooks();
});
elements.mode.addEventListener("change", () => { void switchMode(elements.mode.value); });
elements.reset.addEventListener("click", async () => {
  if (state.busy || !window.confirm("确认重置当前模式的数据？现有记录会被三条示例数据替换。")) return;
  setBusy(true);
  try {
    await repository.reset();
    clearTimeout(searchTimer);
    elements.keyword.value = "";
    elements.status.value = "all";
    elements.sort.value = "id-asc";
    state.page = 1;
    resetForm();
    if (await loadBooks()) announce("当前模式已重置，另一模式的数据不受影响");
  } catch (error) {
    announce(error.message, "error");
  } finally {
    setBusy(false);
  }
});

let savedMode = "local";
try { if (window.localStorage.getItem("js-books-mode") === "api") savedMode = "api"; }
catch { /* 进入页面后由保存层提示。 */ }
void switchMode(savedMode);

