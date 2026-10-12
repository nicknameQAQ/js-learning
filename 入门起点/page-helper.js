// 这是当前练习的现成工具。先会调用，之后再学习自己实现它。
// 这不是完整项目的参考答案；只负责显示一个书名和价格。
function showBook(title, priceCents) {
  const notice = document.querySelector("#notice");
  if (typeof title !== "string" || title.trim().length === 0) {
    notice.dataset.error = "true";
    notice.textContent = "书名需要是非空文本。看看你有没有加引号，或者是不是只写了空格。";
    return;
  }
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
    notice.dataset.error = "true";
    notice.textContent = "价格需要是非负整数分。数字不用引号，例如 3500 表示 35 元。";
    return;
  }
  document.querySelector("#book-title").textContent = title;
  document.querySelector("#book-price").textContent = (priceCents / 100).toFixed(2);
  notice.dataset.error = "false";
  notice.textContent = "已显示你写的数据。再改一个书名，试试 0 元，保存后刷新看看。";
}

