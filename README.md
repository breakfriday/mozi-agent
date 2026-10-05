![Uploading image.webp…]()
Mozi 基于 Electron 与 Pi 构建，利用 Pi SDK 的进程内嵌入能力，在自有后台进程中直接创建和运行 Agent Runtime，通过 IPC （utilityProcess.fork() + postMessage()）与主进程通信，支持运行时生命周期管理与深度定制。
