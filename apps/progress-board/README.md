# Vibe Coding Development Cockpit v0.1

只读的本地开发施工驾驶舱，聚合 Ralph、education-payroll 与当前 Dashboard fixture 的真实证据。

在 Ralph 仓库根目录运行：

```sh
npm run progress-board
```

然后打开 <http://127.0.0.1:4173>。默认读取同级目录中的 `education-payroll-longrun-20260913`；可用 `PROGRESS_BOARD_ROOT` 指定 Ralph 根目录，`PROGRESS_BOARD_PORT` 指定端口。

页面不会写入任何项目状态，也不会启动 Worker、Gate、Review 或修改 Git。
