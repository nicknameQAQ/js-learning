// 不依赖 Playwright：用本机 Chromium 浏览器的 DevTools 协议验证真实页面。
// 测试使用新浏览器配置和独立临时数据，不会改你的练习数据。
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createBooksServer } from "../server.mjs";
import { temporaryDirectory, listen, close } from "./helpers.mjs";

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* 继续检查下一条。 */ }
  }
  throw new Error("未找到 Edge / Chrome。安装浏览器，或设置 BROWSER_PATH 后再运行。");
}

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = () => {};
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
      } else this.onEvent(message);
    });
  }
  call(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("DevTools 超时：" + method));
      }, 15000);
      this.pending.set(id, { resolve: resolveCall, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

const directory = await temporaryDirectory("js-books-browser-");
let server;
let child;
let socket;
let cdp;
let session;
let dialogAccept = true;
let checks = 0;
const runtimeErrors = [];

try {
  const browserPath = await findBrowser();
  server = await createBooksServer({ dataDir: directory.path + "/data" });
  const base = await listen(server);
  child = spawn(browserPath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--remote-debugging-port=0",
    "--user-data-dir=" + directory.path + "/profile", "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const debuggerUrl = await withTimeout(new Promise((resolveUrl, reject) => {
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match) resolveUrl(match[1]);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error("浏览器提前退出：" + code + "。检查 BROWSER_PATH。")));
  }), 20000, "浏览器未启动 DevTools");

  socket = new WebSocket(debuggerUrl);
  await withTimeout(new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error("无法连接本机 DevTools")), { once: true });
  }), 10000, "连接 DevTools 超时");
  cdp = new DevTools(socket);
  const target = await cdp.call("Target.createTarget", { url: "about:blank" });
  session = (await cdp.call("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
  cdp.onEvent = (message) => {
    if (message.sessionId !== session) return;
    if (message.method === "Runtime.exceptionThrown") {
      runtimeErrors.push(message.params.exceptionDetails.exception?.description
        ?? message.params.exceptionDetails.text);
    }
    if (message.method === "Page.javascriptDialogOpening") {
      void cdp.call("Page.handleJavaScriptDialog", { accept: dialogAccept }, session);
    }
  };
  await cdp.call("Page.enable", {}, session);
  await cdp.call("Runtime.enable", {}, session);
  await cdp.call("Network.enable", {}, session);
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 1360, height: 1000, deviceScaleFactor: 1, mobile: false,
  }, session);

  async function evaluate(expression) {
    const result = await cdp.call("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本错误");
    return result.result.value;
  }
  async function waitFor(expression, label, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await evaluate(expression)) return; } catch { /* 刷新时上下文会短暂消失。 */ }
      await delay(50);
    }
    throw new Error("等待失败：" + label + "；页面状态：" + await evaluate("document.body.innerText"));
  }
  async function click(selector) {
    await evaluate("document.querySelector(" + JSON.stringify(selector) + ").click()");
  }
  async function setField(selector, value, event = "input") {
    await evaluate("(() => { const el = document.querySelector(" + JSON.stringify(selector)
      + "); el.value = " + JSON.stringify(value) + "; el.dispatchEvent(new Event("
      + JSON.stringify(event) + ", {bubbles:true})); })()");
  }
  async function count(value) {
    await waitFor("document.querySelector('#stat-count')?.textContent === " + JSON.stringify(String(value))
      + " && !document.querySelector('#save').disabled", "图书数量 " + value);
  }
  function pass(label) { checks += 1; console.log("通过：" + label); }
  async function reload() {
    await cdp.call("Page.reload", {}, session);
    await waitFor("document.querySelector('#list-state')?.hidden === true", "刷新后页面加载");
  }
  async function add(title, price = "12.34") {
    await setField("#title", title);
    await setField("#author", "测试作者");
    await setField("#price", price);
    await click("#save");
    await waitFor("document.querySelector('#message').textContent === '图书已新增' && !document.querySelector('#save').disabled", "新增成功");
  }
  async function clearSearch() {
    await setField("#keyword", "");
    await waitFor("document.querySelector('#list-state').hidden === true", "清空查询");
    await delay(300);
  }
  async function reset() {
    dialogAccept = true;
    await click("#reset");
    await waitFor("document.querySelector('#message').textContent.includes('已重置') && !document.querySelector('#save').disabled", "重置");
    await count(3);
  }

  await cdp.call("Page.navigate", { url: base }, session);
  await count(3);
  assert.equal(await evaluate("document.querySelector('#stat-price').textContent"), "¥ 118.00");
  pass("初始数据、零金额和总价显示");

  await setField("#title", "  ");
  await setField("#author", "作者");
  await setField("#price", "1");
  await click("#save");
  await waitFor("document.querySelector('#message').textContent.includes('书名不能为空')", "表单校验");
  await count(3);
  for (const badPrice of ["-1", "12.345", "1e2", "1000000.01", ""]) {
    await setField("#title", "金额校验");
    await setField("#price", badPrice);
    await click("#save");
    assert.equal(await evaluate("document.querySelector('#message').dataset.kind"), "error");
    await count(3);
  }
  pass("非法表单不写入");

  await add("本地测试", "0");
  await count(4);
  await reload();
  await count(4);
  await click('tr[data-id="4"] [data-action="edit"]');
  await waitFor("document.querySelector('#form-title').textContent.includes('#4') && !document.querySelector('#save').disabled", "编辑回显");
  assert.equal(await evaluate("document.querySelector('#price').value"), "0.00");
  await setField("#title", "本地已编辑");
  await setField("#price", "0.29");
  await click("#save");
  await waitFor("document.querySelector('#message').textContent === '修改已保存'", "保存编辑");
  await reload();
  assert.equal(await evaluate("document.querySelector('tr[data-id=\"4\"] .book-title').textContent"), "本地已编辑");
  pass("本地新增、回显、编辑与刷新保存");

  dialogAccept = false;
  await click('tr[data-id="4"] [data-action="delete"]');
  await delay(150);
  await count(4);
  dialogAccept = true;
  await click('tr[data-id="4"] [data-action="delete"]');
  await count(3);
  pass("取消与确认删除");

  const dangerousTitle = "<img src=x onerror=alert(1)>";
  await add(dangerousTitle);
  assert.equal(await evaluate("document.querySelector('tr[data-id=\"5\"] .book-title').textContent"), dangerousTitle);
  assert.equal(await evaluate("document.querySelector('#book-list img') === null"), true);
  pass("书名作为文本显示，删除编号不重用");

  await setField("#keyword", " JAVA ");
  await count(2);
  await setField("#status", "false", "change");
  await count(0);
  assert.equal(await evaluate("document.querySelector('#prev').disabled && document.querySelector('#next').disabled"), true);
  await setField("#status", "all", "change");
  await count(2);
  await clearSearch();
  await count(4);
  await setField("#sort", "price-asc", "change");
  assert.equal(await evaluate("document.querySelector('#book-list tr').dataset.id"), "3");
  pass("搜索、状态、空结果与排序组合");

  await reset();
  for (let i = 0; i < 5; i++) await add("分页测试 " + i, "1");
  await count(8);
  assert.equal(await evaluate("document.querySelectorAll('#book-list tr').length"), 5);
  await click("#next");
  await waitFor("document.querySelector('#page-info').textContent.includes('2 / 2')", "第二页");
  assert.equal(await evaluate("document.querySelectorAll('#book-list tr').length"), 3);
  assert.equal(await evaluate("document.querySelector('#stat-count').textContent"), "8");
  pass("分页与全量统计");

  for (const id of [6, 7, 8]) {
    await click('tr[data-id="' + id + '"] [data-action="delete"]');
    await waitFor("!document.querySelector('#save').disabled && document.querySelector('#message').textContent === '图书已删除'", "删除末页记录");
  }
  await count(5);
  assert.equal(await evaluate("document.querySelector('#page-info').textContent"), "第 1 / 1 页");
  pass("删除末页最后记录后自动回到上一页");

  await evaluate("localStorage.setItem('js-books-learning-v1', 'broken')");
  await cdp.call("Page.reload", {}, session);
  await waitFor("document.querySelector('#message')?.textContent.includes('本地数据损坏')", "缓存损坏提示");
  assert.equal(await evaluate("localStorage.getItem('js-books-learning-v1')"), "broken");
  await reset();
  pass("损坏缓存保留，确认重置后恢复");

  await setField("#mode", "api", "change");
  await count(3);
  await add("接口测试");
  await count(4);
  await reload();
  await count(4);
  assert.equal(await evaluate("document.querySelector('#mode').value"), "api");
  pass("接口新增、刷新持久化、模式记忆");

  await click('tr[data-id="4"] [data-action="edit"]');
  await waitFor("document.querySelector('#form-title').textContent.includes('#4') && !document.querySelector('#save').disabled", "接口编辑");
  await setField("#title", "接口已编辑");
  await setField("#price", "0.00");
  await click("#save");
  await waitFor("document.querySelector('#message').textContent === '修改已保存'", "接口修改完成");
  await click('tr[data-id="4"] [data-action="delete"]');
  await count(3);
  pass("接口编辑、删除与空的 204 响应");

  // 模拟请求失败，检查表单输入保留以及按钮恢复。
  await evaluate("window.__originalFetch = window.fetch; window.fetch = (url, options) => options?.method === 'POST' && String(url).endsWith('/books') ? Promise.reject(new TypeError('测试断网')) : window.__originalFetch(url, options)");
  await setField("#title", "失败后保留");
  await setField("#author", "作者");
  await setField("#price", "9.99");
  await click("#save");
  await waitFor("document.querySelector('#message').textContent.includes('连接失败') && !document.querySelector('#save').disabled", "失败恢复");
  assert.equal(await evaluate("document.querySelector('#title').value"), "失败后保留");
  await count(3);
  await evaluate("window.fetch = window.__originalFetch");
  pass("请求失败保留表单并恢复按钮");

  await evaluate("(() => { const form = document.querySelector('#book-form'); form.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})); form.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})); })()");
  await waitFor("document.querySelector('#message').textContent === '图书已新增' && !document.querySelector('#save').disabled", "连续提交完成");
  await count(4);
  await click('tr[data-id="5"] [data-action="delete"]');
  await count(3);
  pass("保存中连续提交只创建一条记录");

  // 真实网络离线：列表加载失败、恢复网络后能重新加载。
  await cdp.call("Network.emulateNetworkConditions", {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  }, session);
  await click("#reload");
  await waitFor("document.querySelector('#message').textContent.includes('连接失败')", "离线提示");
  await cdp.call("Network.emulateNetworkConditions", {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  }, session);
  await click("#reload");
  await count(3);
  pass("真实浏览器离线提示与重试");

  // 故意让旧查询忽略取消并更晚完成，验证序号保护真的有效。
  await evaluate("window.__slowStarted = false; window.__originalFetch = window.fetch; window.fetch = async (url, options) => { if (String(url).includes('keyword=Java')) { window.__slowStarted = true; const response = await window.__originalFetch(url, {...options, signal:undefined}); await new Promise(r => setTimeout(r, 700)); return response; } return window.__originalFetch(url, options); }");
  await setField("#keyword", "Java");
  await waitFor("window.__slowStarted", "旧请求已发出");
  await setField("#keyword", "Python");
  await count(1);
  await delay(850);
  assert.equal(await evaluate("document.querySelector('#book-list .book-title').textContent"), "Python 起步");
  await evaluate("window.fetch = window.__originalFetch");
  await clearSearch();
  await count(3);
  pass("旧请求后到不会覆盖新搜索");

  await setField("#mode", "local", "change");
  await count(3);
  await add("只在本地");
  await count(4);
  await setField("#mode", "api", "change");
  await count(3);
  await setField("#mode", "local", "change");
  await count(4);
  pass("两个模式的数据互相独立");

  await reset();
  if (process.env.BOOKS_SCREENSHOT_PATH) {
    const desktop = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, session);
    await writeFile(process.env.BOOKS_SCREENSHOT_PATH, Buffer.from(desktop.data, "base64"));
  }
  assert.equal(await evaluate("document.documentElement.scrollWidth <= 1360"), true);
  await cdp.call("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  }, session);
  await delay(150);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= 390"), true);
  if (process.env.BOOKS_SCREENSHOT_PATH) {
    const mobile = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, session);
    const mobilePath = process.env.BOOKS_SCREENSHOT_PATH.replace(/\.png$/i, "") + "-mobile.png";
    await writeFile(mobilePath, Buffer.from(mobile.data, "base64"));
  }
  pass("桌面和手机布局无整页横向溢出");
  assert.deepEqual(runtimeErrors, []);
  console.log("浏览器验证完成：" + checks + " 组场景，无未处理脚本异常。");
} finally {
  if (cdp && socket?.readyState === WebSocket.OPEN) {
    await cdp.call("Browser.close").catch(() => {});
    socket.close();
  }
  if (child && child.exitCode === null) {
    await withTimeout(new Promise((resolveExit) => child.once("exit", resolveExit)), 4000, "关闭浏览器超时")
      .catch(() => child.kill());
    await delay(200);
  }
  await close(server);
  await directory.cleanup();
}

