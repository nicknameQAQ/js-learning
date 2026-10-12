import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, sep, basename } from "node:path";

export async function temporaryDirectory(prefix = "js-books-test-") {
  const base = resolve(tmpdir());
  const directory = await mkdtemp(join(base, prefix));
  return {
    path: directory,
    async cleanup() {
      const target = resolve(directory);
      // 删除前核对最终绝对路径，只移除本次测试创建的临时目录。
      if (!target.startsWith(base + sep) || !basename(target).startsWith(prefix)) {
        throw new Error("拒绝清理意外路径：" + target);
      }
      await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    },
  };
}

export function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen("http://127.0.0.1:" + server.address().port);
    });
  });
}

export function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
    server.closeAllConnections();
  });
}

