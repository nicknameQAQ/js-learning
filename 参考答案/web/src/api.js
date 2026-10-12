import { AppError } from "./domain.js";

export function createApiRepository(base = "/api") {
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(base + path, {
        ...options,
        headers: { "Content-Type": "application/json", ...options.headers },
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new AppError("连接失败，请检查服务是否启动，或浏览器是否处于离线状态");
    }
    // 删除成功没有响应体；无条件解析 JSON 会失败。
    if (response.status === 204) return undefined;
    let body;
    try {
      body = await response.json();
    } catch {
      throw new AppError("接口返回的不是合法 JSON，请检查请求地址与服务日志", response.status);
    }
    if (!response.ok || body.code !== 0) {
      throw new AppError(body.message || "接口请求失败", response.status);
    }
    return body.data;
  }

  return {
    list(query, options = {}) {
      const params = new URLSearchParams(query);
      return request("/books?" + params, { signal: options.signal });
    },
    get(id) { return request("/books/" + id); },
    add(input) { return request("/books", { method: "POST", body: JSON.stringify(input) }); },
    update(id, input) {
      return request("/books/" + id, { method: "PUT", body: JSON.stringify(input) });
    },
    remove(id) { return request("/books/" + id, { method: "DELETE" }); },
    reset() { return request("/reset", { method: "POST" }); },
  };
}

