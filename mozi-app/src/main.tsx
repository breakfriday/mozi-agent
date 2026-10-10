import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

if (import.meta.env.DEV) {
  //void：表示这里不使用返回的 Promise，不等待加载完成；它不会捕获加载错误。
  void import("./devtools/storeDebug");
}

// const module = await import("./someModule");
// module.someFunction();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
