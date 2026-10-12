import {
  AppError, createSeedState, validateStoredState, queryBooks,
  addBook, getBook, updateBook, removeBook,
} from "./domain.js";

export const STORAGE_KEY = "js-books-learning-v1";

export function createLocalRepository(storage, key = STORAGE_KEY) {
  function write(state) {
    try {
      storage.setItem(key, JSON.stringify(state));
    } catch {
      throw new AppError("浏览器无法保存数据，请检查隐私设置或存储空间");
    }
  }

  function read() {
    let raw;
    try {
      raw = storage.getItem(key);
    } catch {
      throw new AppError("无法读取浏览器存储，请检查隐私设置");
    }
    // 只在键不存在时初始化。空数组是正常数据，不重新填入示例。
    if (raw === null) {
      const seed = createSeedState();
      write(seed);
      return seed;
    }
    try {
      return validateStoredState(JSON.parse(raw));
    } catch {
      throw new AppError("本地数据损坏，原数据已保留。备份后可点“重置当前数据”");
    }
  }

  // 两个保存层接口一致。页面不必关心数据放在哪。
  return {
    async list(query) { return queryBooks(read().books, query); },
    async get(id) { return getBook(read(), id); },
    async add(input) {
      const state = read();
      const book = addBook(state, input);
      write(state);
      return book;
    },
    async update(id, input) {
      const state = read();
      const book = updateBook(state, id, input);
      write(state);
      return book;
    },
    async remove(id) {
      const state = read();
      removeBook(state, id);
      write(state);
    },
    async reset() {
      const seed = createSeedState();
      write(seed);
      return queryBooks(seed.books);
    },
  };
}

