// 本阶段：显示图书列表、表单新增、删除、数量和总价统计。
// 先读同目录的“任务说明.md”，HTML / CSS 已经准备好。
// 在这里自己实现 JS。可以拆函数，遇到不懂的再问。
const books = [
    {
        id : 1,
        title : "Java入门",
        author : "示例作者A",
        priceCents : 5000
    },
    {
        id : 2,
        title : "JavaScript 实战",
        author : "示例作者B",
        priceCents : 6800
    },
    {
        id : 3,
        title : "Python 起步",
        author : "示例作者C",
        priceCents : 0
    }
];
const tbody = document.querySelector("#book-list");


//
function renderBooks(){
    tbody.textContent = "";
    for (const book of books) {
    const tr = document.createElement("tr");
    const idtd = document.createElement("td"); 
    const titletd = document.createElement("td");
    const authortd = document.createElement("td");
    const priceCentstd = document.createElement("td");

    //获取对象填入td
    idtd.textContent = book.id;
    titletd.textContent = book.title;
    authortd.textContent = book.author;
    priceCentstd.textContent = (book.priceCents/100).toFixed(2);
    
    //填入行tr
    tr.appendChild(idtd);
    tr.appendChild(titletd);
    tr.appendChild(authortd);
    tr.appendChild(priceCentstd);

    
    //填入tbody主体
    tbody.appendChild(tr);
    
    //删除按钮
    const actiontd = document.createElement("td");
    const deleteButton = document.createElement("button");
    deleteButton.textContent = "删除";
    deleteButton.type = "button";
    actiontd.appendChild(deleteButton);
    tr.appendChild(actiontd);
    deleteButton.addEventListener("click",function(){
        console.log("准备删除的图书编号: ",book.id);
        if (!confirm("确定删除这本书吗?")) {
            return;
        }
        const index = books.findIndex(function (item){
            return item.id === book.id;
        });
        if (index !== -1) {
            books.splice(index,1);
            renderBooks();
            
        }
    });
}
const emptyState = document.querySelector("#empty-state");
emptyState.hidden = books.length > 0;
}
renderBooks();




