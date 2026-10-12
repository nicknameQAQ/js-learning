// Node 只负责本地静态服务、模拟接口和 JSON 持久化，没有第三方依赖。
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, dirname, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AppError, createSeedState, validateStoredState, queryBooks,
  addBook, getBook, updateBook, removeBook,
} from "./web/src/domain.js";

const here = dirname(fileURLToPath(import.meta.url));

function sendJson(response, status, data = null, message = "ok") {
  if (status === 204) { response.writeHead(204); response.end(); return; }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ code: status < 400 ? 0 : status, message, data }));
}

function readJson(request) {
  if ((request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AppError("请使用 Content-Type: application/json", 415);
  }
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 16384) { tooLarge = true; chunks.length = 0; }
      else if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) { reject(new AppError("请求体不能超过 16 KiB", 413)); return; }
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new AppError("请求体不是合法 JSON")); }
    });
    request.on("error", reject);
  });
}

export async function createBooksServer({
  rootDir = resolve(here, "web"),
  dataDir = resolve(here, "..", ".data"),
} = {}) {
  rootDir = resolve(rootDir);
  dataDir = resolve(dataDir);
  await mkdir(dataDir, { recursive: true });
  const dataFile = resolve(dataDir, "books.json");
  let state;

  async function persist(nextState) {
    const temporary = dataFile + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(nextState, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      await rename(temporary, dataFile);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  let raw;
  try { raw = await readFile(dataFile, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("无法读取数据文件：" + dataFile + "；" + error.message);
  }
  if (raw === undefined) {
    state = createSeedState();
    await persist(state);
  } else {
    try { state = validateStoredState(JSON.parse(raw)); }
    catch (error) {
      throw new Error("数据文件损坏，已保留原文件：" + dataFile + "；" + error.message);
    }
  }

  let writeQueue = Promise.resolve();
  function mutate(callback) {
    const task = writeQueue.then(async () => {
      // 先修改副本，落盘成功后才替换内存。失败不留下“只保存了一半”的数据。
      const nextState = structuredClone(state);
      const result = callback(nextState);
      await persist(nextState);
      state = nextState;
      return result;
    });
    // 当前请求收到错误，但队列仍能继续处理后续请求。
    writeQueue = task.catch(() => {});
    return task;
  }

  const mime = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  };

  const server = createServer(async (request, response) => {
    try {
      const port = server.address().port;
      const allowedHosts = ["127.0.0.1:" + port, "localhost:" + port];
      if (!allowedHosts.includes(request.headers.host)) throw new AppError("只接受本机地址访问", 403);
      const url = new URL(request.url, "http://127.0.0.1:" + port);
      if (!["GET", "HEAD"].includes(request.method) && request.headers.origin
          && !allowedHosts.map((host) => "http://" + host).includes(request.headers.origin)) {
        throw new AppError("请从本机同源页面执行写操作", 403);
      }

      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/reset" && request.method === "POST") {
          const result = await mutate((nextState) => {
            Object.assign(nextState, createSeedState());
            return queryBooks(nextState.books);
          });
          sendJson(response, 200, result);
          return;
        }

        if (url.pathname === "/api/books") {
          if (request.method === "GET") {
            await writeQueue;
            sendJson(response, 200, queryBooks(state.books, Object.fromEntries(url.searchParams)));
            return;
          }
          if (request.method === "POST") {
            const input = await readJson(request);
            sendJson(response, 201, await mutate((nextState) => addBook(nextState, input)));
            return;
          }
          throw new AppError("此接口不支持该请求方法", 405);
        }

        const match = /^\/api\/books\/([^/]+)$/.exec(url.pathname);
        if (match) {
          if (request.method === "GET") {
            await writeQueue;
            sendJson(response, 200, getBook(state, match[1]));
            return;
          }
          if (request.method === "PUT") {
            const input = await readJson(request);
            sendJson(response, 200, await mutate((nextState) => updateBook(nextState, match[1], input)));
            return;
          }
          if (request.method === "DELETE") {
            await mutate((nextState) => removeBook(nextState, match[1]));
            sendJson(response, 204);
            return;
          }
          throw new AppError("此接口不支持该请求方法", 405);
        }
        throw new AppError("接口不存在", 404);
      }

      if (!["GET", "HEAD"].includes(request.method)) throw new AppError("页面只支持 GET 或 HEAD", 405);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { throw new AppError("页面地址编码不合法"); }
      if (pathname.includes("\\") || pathname.includes("\0")
          || pathname.split("/").some((part) => part.startsWith("."))) {
        throw new AppError("页面不存在", 404);
      }
      const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
      const filePath = resolve(rootDir, relativePath);
      if (!filePath.startsWith(rootDir + sep) || !mime[extname(filePath)]) throw new AppError("页面不存在", 404);
      let content;
      try { content = await readFile(filePath); }
      catch (error) {
        if (["ENOENT", "EISDIR", "ENOTDIR"].includes(error.code)) throw new AppError("页面不存在", 404);
        throw error;
      }
      response.writeHead(200, {
        "Content-Type": mime[extname(filePath)], "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      if (status === 500) console.error(error);
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, status, null, status === 500 ? "服务读写失败，请查看终端日志" : error.message);
      }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

async function start() {
  const { values } = parseArgs({
    options: {
      root: { type: "string" }, port: { type: "string", default: "3000" },
      "data-dir": { type: "string" },
    },
  });
  if (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) {
    throw new Error("--port 必须是 1～65535 的整数");
  }
  const rootDir = values.root ? resolve(values.root) : resolve(here, "web");
  const dataDir = values["data-dir"] ? resolve(values["data-dir"]) : resolve(here, "..", ".data");
  const server = await createBooksServer({ rootDir, dataDir });
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? "端口已占用，请换一个 --port，或停止原来的服务。" : error.message);
    process.exitCode = 1;
  });
  server.listen(Number(values.port), "127.0.0.1", () => {
    console.log("图书管理已启动：http://127.0.0.1:" + values.port);
    console.log("页面目录：" + rootDir);
    console.log("接口数据：" + resolve(dataDir, "books.json"));
    console.log("按 Ctrl+C 停止。");
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

